/**
 * UniPortal API - Serveur HTTP
 * ==========================================================================
 * Backend leger, sans dependance (Node.js 18 ou plus) qui joue le role de
 * l'"API metier" du §3.3.2 :
 *   - il sert les fichiers du frontend (meme origine : pas de CORS) ;
 *   - il expose /api/*, ou chaque requete doit porter un access token valide
 *     dans l'en-tete Authorization (§3.4, etape 6).
 *
 * Codes de reponse, conformes au tableau de depannage du §3.9 :
 *   401 : jeton absent, expire, invalide ou mauvaise audience
 *   403 : identite valide mais action interdite (role, propriete, affectation)
 *   502 : cles publiques du tenant injoignables (probleme reseau sortant)
 *
 * Lancement : `npm start` depuis le dossier uniportal (voir README).
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVerifier, TokenError, JwksError } from './jwt.js';
import {
  TRIMESTRES, MATIERES, CLASSES, AFFECTATIONS, eleveForUser, findEleve, bulletin, releveClasse, enregistrerNote,
} from './data.js';

/* --------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROLES_NAMESPACE = 'https://uniportal.example.com/roles';

/**
 * Lit une valeur de AUTH0_CONFIG dans js/auth.js, pour ne configurer le
 * tenant qu'a un seul endroit. Une variable d'environnement reste prioritaire.
 */
function readFrontendConfig(key) {
  try {
    const source = readFileSync(join(ROOT, 'js', 'auth.js'), 'utf8');
    const match = source.match(new RegExp(`${key}:\\s*'([^']+)'`));
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

const PORT = Number(process.env.PORT) || 8080;
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || readFrontendConfig('domain');
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || readFrontendConfig('audience');

if (!AUTH0_DOMAIN || AUTH0_DOMAIN.startsWith('VOTRE-') || !AUTH0_AUDIENCE) {
  console.warn('[api] Tenant Auth0 non configure : renseignez js/auth.js ou AUTH0_DOMAIN / AUTH0_AUDIENCE.');
  console.warn('[api] Le frontend est servi, mais toute requete /api protegee sera refusee.');
}

const verifyToken = createVerifier({ domain: AUTH0_DOMAIN, audience: AUTH0_AUDIENCE });

/* --------------------------------------------------------------------------
   Reponses HTTP
   -------------------------------------------------------------------------- */

/** En-tetes de securite communs a toutes les reponses. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

/** Erreur metier portant un statut HTTP. */
class HttpError extends Error {
  constructor(status, code, message, checks) {
    super(message);
    this.status = status;
    this.code = code;
    this.checks = checks;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/**
 * Traduit une erreur en reponse JSON. Pour un 401, l'en-tete
 * WWW-Authenticate indique au client le schema attendu (RFC 6750).
 */
function sendError(res, err) {
  const headers = {};
  if (err.status === 401) {
    // Valeur d'en-tete HTTP : ASCII uniquement, accents retires.
    const desc = err.message.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '\'');
    headers['WWW-Authenticate'] = `Bearer realm="uniportal", error="${err.code}", error_description="${desc}"`;
  }
  sendJson(res, err.status, { error: err.code, message: err.message, checks: err.checks }, headers);
}

/* --------------------------------------------------------------------------
   Authentification et autorisation
   -------------------------------------------------------------------------- */

/**
 * Extrait et valide l'access token de l'en-tete Authorization.
 * @returns {Promise<{claims: object, roles: string[], checks: object[]}>}
 */
async function authenticate(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (!header) {
    throw new HttpError(401, 'invalid_request', 'En-tête Authorization absent : un access token est requis.', [
      { name: 'En-tête Authorization', ok: false, detail: 'Absent de la requête.' },
    ]);
  }
  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'invalid_request', 'Format attendu : "Authorization: Bearer <access_token>".', [
      { name: 'En-tête Authorization', ok: false, detail: `Schéma "${scheme}" non reconnu.` },
    ]);
  }

  try {
    const { payload, checks } = await verifyToken(token);
    const roles = Array.isArray(payload[ROLES_NAMESPACE]) ? payload[ROLES_NAMESPACE] : [];
    return { claims: payload, roles, checks: [{ name: 'En-tête Authorization', ok: true, detail: 'Bearer' }, ...checks] };
  } catch (e) {
    if (e instanceof TokenError) {
      throw new HttpError(401, 'invalid_token', e.message, [{ name: 'En-tête Authorization', ok: true, detail: 'Bearer' }, ...e.checks]);
    }
    if (e instanceof JwksError) throw new HttpError(502, 'jwks_unavailable', e.message);
    throw e;
  }
}

/**
 * Verifie le role requis (RBAC, §3.5.3). Un utilisateur sans role n'a aucun
 * droit : principe du moindre privilege.
 */
function requireRole(auth, role) {
  const ok = auth.roles.includes(role);
  auth.checks.push({
    name: `Rôle "${role}"`,
    ok,
    detail: ok ? 'Présent dans la claim des rôles.' : `Rôles du jeton : ${JSON.stringify(auth.roles)}.`,
  });
  if (!ok) throw new HttpError(403, 'insufficient_role', `Action réservée au rôle "${role}".`, auth.checks);
}

/** Ajoute un controle metier et refuse (403) s'il echoue. */
function requireRule(auth, ok, name, detail, message) {
  auth.checks.push({ name, ok, detail });
  if (!ok) throw new HttpError(403, 'forbidden', message, auth.checks);
}

/* --------------------------------------------------------------------------
   Routes de l'API
   -------------------------------------------------------------------------- */

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, 'payload_too_large', 'Corps de requête trop volumineux.');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'invalid_json', 'Corps JSON invalide.');
  }
}

/** Lit et valide le parametre ?trimestre= (1, 2 ou 3 ; 3 par defaut). */
function trimestreParam(url) {
  const t = Number(url.searchParams.get('trimestre') || 3);
  if (!TRIMESTRES.includes(t)) throw new HttpError(400, 'invalid_trimester', 'Le trimestre doit valoir 1, 2 ou 3.');
  return t;
}

/** Verifie l'affectation du professeur a la classe et a la matiere (§3.5.3). */
function requireAffectation(auth, classe, matiere) {
  if (!CLASSES[classe]) throw new HttpError(404, 'not_found', `Aucune classe ${classe}.`);
  if (!MATIERES[matiere]) throw new HttpError(404, 'not_found', `Aucune matière ${matiere}.`);
  const ok = AFFECTATIONS.some((a) => a.classe === classe && a.matiere === matiere);
  requireRule(auth, ok, 'Affectation',
    `Demandé : ${matiere} en ${classe} ; affectations : ${AFFECTATIONS.map((a) => `${a.matiere} en ${a.classe}`).join(', ')}.`,
    `Vous n'enseignez pas cette matière dans cette classe.`);
}

/**
 * Table de routage : [methode, motif, gestionnaire].
 * Les gestionnaires recoivent la requete, l'URL analysee et les groupes
 * captures du motif.
 */
const ROUTES = [
  // Route publique : permet au frontend de detecter l'API.
  ['GET', /^\/api\/sante$/, async () => ({
    status: 'ok',
    issuer: `https://${AUTH0_DOMAIN}/`,
    audience: AUTH0_AUDIENCE,
  })],

  // Bulletin de l'eleve connecte : la fiche est retrouvee par la claim sub.
  ['GET', /^\/api\/eleves\/me\/bulletin$/, async (req, url) => {
    const auth = await authenticate(req);
    requireRole(auth, 'eleve');
    const eleve = eleveForUser(auth.claims);
    auth.checks.push({ name: 'Propriété', ok: true, detail: `Fiche ${eleve.id} rattachée au sub du jeton.` });
    return { ...bulletin(eleve, trimestreParam(url)), checks: auth.checks };
  }],

  // Bulletin d'un eleve par son identifiant : illustre la modification d'URL du §3.9.
  // Un eleve n'accede qu'a sa propre fiche ; un professeur, aux eleves de ses classes.
  ['GET', /^\/api\/eleves\/([\w-]+)\/bulletin$/, async (req, url, id) => {
    const auth = await authenticate(req);
    const eleve = findEleve(id);
    if (!eleve) throw new HttpError(404, 'not_found', `Aucun élève ${id}.`);

    if (auth.roles.includes('professeur')) {
      const ok = AFFECTATIONS.some((a) => a.classe === eleve.classe);
      requireRule(auth, ok, 'Affectation', `Élève de ${eleve.classe}.`, 'Cet élève n\'appartient à aucune de vos classes.');
    } else {
      requireRole(auth, 'eleve');
      const own = eleveForUser(auth.claims);
      requireRule(auth, own.id === eleve.id, 'Propriété',
        own.id === eleve.id ? 'La fiche appartient au demandeur.' : `Fiche ${eleve.id} demandée, fiche du demandeur : ${own.id}.`,
        'Ce bulletin appartient à un autre élève : le jeton est valide, mais l\'accès est refusé.');
    }
    return { ...bulletin(eleve, trimestreParam(url)), checks: auth.checks };
  }],

  // Classes et matieres du professeur connecte.
  ['GET', /^\/api\/professeurs\/me\/affectations$/, async (req) => {
    const auth = await authenticate(req);
    requireRole(auth, 'professeur');
    return {
      professeur: { nom: auth.claims['https://uniportal.example.com/name'] || null },
      affectations: AFFECTATIONS.map((a) => ({ classe: CLASSES[a.classe], matiere: { code: a.matiere, nom: MATIERES[a.matiere].nom } })),
      checks: auth.checks,
    };
  }],

  // Releve d'une classe pour une matiere : professeur affecte uniquement.
  ['GET', /^\/api\/classes\/([\w-]+)\/matieres\/([\w-]+)\/eleves$/, async (req, url, classe, matiere) => {
    const auth = await authenticate(req);
    requireRole(auth, 'professeur');
    requireAffectation(auth, classe, matiere);
    return { ...releveClasse(classe, matiere, trimestreParam(url)), checks: auth.checks };
  }],

  // Saisie d'une moyenne et d'une appreciation : professeur affecte uniquement.
  ['PUT', /^\/api\/classes\/([\w-]+)\/matieres\/([\w-]+)\/notes\/([\w-]+)$/, async (req, url, classe, matiere, id) => {
    const auth = await authenticate(req);
    requireRole(auth, 'professeur');
    requireAffectation(auth, classe, matiere);
    const eleve = findEleve(id);
    if (!eleve || eleve.classe !== classe) throw new HttpError(404, 'not_found', `Aucun élève ${id} en ${classe}.`);

    // Le serveur revalide la saisie : le formulaire du navigateur peut etre contourne.
    const { trimestre, note, appreciation } = await readJsonBody(req);
    if (!TRIMESTRES.includes(trimestre)) throw new HttpError(400, 'invalid_trimester', 'Le trimestre doit valoir 1, 2 ou 3.');
    if (note !== null && (typeof note !== 'number' || Number.isNaN(note) || note < 0 || note > 20)) {
      throw new HttpError(400, 'invalid_grade', 'La moyenne doit être un nombre compris entre 0 et 20.');
    }
    if (appreciation !== undefined && appreciation !== null && (typeof appreciation !== 'string' || appreciation.length > 300)) {
      throw new HttpError(400, 'invalid_comment', 'L\'appréciation doit être un texte de 300 caractères au plus.');
    }
    const valeur = note === null ? null : Math.round(note * 100) / 100;
    enregistrerNote(id, matiere, trimestre, valeur, appreciation?.trim());
    return { ok: true, classe, matiere, eleve: id, trimestre, note: valeur, checks: auth.checks };
  }],
];

async function handleApi(req, res, url) {
  for (const [method, pattern, handler] of ROUTES) {
    const match = url.pathname.match(pattern);
    if (!match) continue;
    if (req.method !== method) continue;
    const body = await handler(req, url, ...match.slice(1));
    return sendJson(res, 200, body);
  }
  throw new HttpError(404, 'not_found', `Route inconnue : ${req.method} ${url.pathname}`);
}

/* --------------------------------------------------------------------------
   Fichiers statiques du frontend
   Seuls les fichiers publics sont servis : le dossier server/ reste prive.
   -------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PUBLIC_FILES = new Set(['index.html', 'callback.html', 'dashboard.html']);
const PUBLIC_DIRS = new Set(['css', 'js']);

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    decoded = '';
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  const [first] = relative.split(sep);
  const allowed = PUBLIC_FILES.has(relative) || (PUBLIC_DIRS.has(first) && relative.split(sep).length > 1 && !relative.includes('..'));

  if (!allowed || !MIME[extname(relative)]) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Introuvable');
  }

  try {
    const content = await readFile(join(ROOT, relative));
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(relative)], 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Introuvable');
  }
}

/* --------------------------------------------------------------------------
   Serveur
   -------------------------------------------------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const started = Date.now();

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    await handleApi(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err);
    } else {
      console.error('[api] erreur interne :', err);
      sendJson(res, 500, { error: 'server_error', message: 'Erreur interne du serveur.' });
    }
  } finally {
    // Journal d'acces : jamais de jeton ni de secret dans les logs (§3.5.5).
    console.log(`[api] ${new Date().toISOString()} ${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - started} ms)`);
  }
});

server.listen(PORT, () => {
  console.log(`[api] UniPortal sur http://localhost:${PORT}`);
  console.log(`[api] Emetteur attendu : https://${AUTH0_DOMAIN}/`);
  console.log(`[api] Audience attendue : ${AUTH0_AUDIENCE}`);
});
