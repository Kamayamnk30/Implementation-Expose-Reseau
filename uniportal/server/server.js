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
import { COURSES, TEACHER_COURSES, studentForUser, findStudent, transcript, courseRoster, setGrade } from './data.js';

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

/**
 * Table de routage : [methode, motif, gestionnaire].
 * Les gestionnaires recoivent les groupes captures du motif.
 */
const ROUTES = [
  // Route publique : permet au frontend de detecter l'API.
  ['GET', /^\/api\/sante$/, async () => ({
    status: 'ok',
    issuer: `https://${AUTH0_DOMAIN}/`,
    audience: AUTH0_AUDIENCE,
  })],

  // Releve de l'etudiant connecte : la fiche est retrouvee par la claim sub.
  ['GET', /^\/api\/notes\/me$/, async (req) => {
    const auth = await authenticate(req);
    requireRole(auth, 'etudiant');
    const student = studentForUser(auth.claims);
    auth.checks.push({ name: 'Propriété', ok: true, detail: `Fiche ${student.id} rattachée au sub du jeton.` });
    return { ...transcript(student), checks: auth.checks };
  }],

  // Fiche d'un etudiant par son numero : illustre la modification d'URL du §3.9.
  ['GET', /^\/api\/etudiants\/([\w-]+)\/notes$/, async (req, id) => {
    const auth = await authenticate(req);
    const student = findStudent(id);
    if (!student) throw new HttpError(404, 'not_found', `Aucun étudiant ${id}.`);

    if (auth.roles.includes('enseignant')) {
      auth.checks.push({ name: 'Rôle "enseignant"', ok: true, detail: 'Consultation autorisée pour les enseignants.' });
    } else {
      requireRole(auth, 'etudiant');
      const own = studentForUser(auth.claims);
      requireRule(auth, own.id === student.id, 'Propriété',
        own.id === student.id ? 'La fiche appartient au demandeur.' : `Fiche ${student.id} demandée, fiche du demandeur : ${own.id}.`,
        'Cette fiche appartient à un autre étudiant : le jeton est valide, mais l\'accès est refusé.');
    }
    return { ...transcript(student), checks: auth.checks };
  }],

  // Liste des etudiants d'un cours : enseignant affecte uniquement.
  ['GET', /^\/api\/cours\/([\w-]+)\/etudiants$/, async (req, code) => {
    const auth = await authenticate(req);
    requireRole(auth, 'enseignant');
    if (!COURSES[code]) throw new HttpError(404, 'not_found', `Aucun cours ${code}.`);
    requireRule(auth, TEACHER_COURSES.includes(code), 'Affectation au cours',
      `Cours demandé : ${code}, cours affectés : ${TEACHER_COURSES.join(', ')}.`,
      `Vous n'êtes pas affecté au cours ${code}.`);
    return { ...courseRoster(code), checks: auth.checks };
  }],

  // Saisie d'une note : enseignant affecte, note comprise entre 0 et 20.
  ['PUT', /^\/api\/cours\/([\w-]+)\/notes\/([\w-]+)$/, async (req, code, id) => {
    const auth = await authenticate(req);
    requireRole(auth, 'enseignant');
    if (!COURSES[code]) throw new HttpError(404, 'not_found', `Aucun cours ${code}.`);
    requireRule(auth, TEACHER_COURSES.includes(code), 'Affectation au cours',
      `Cours demandé : ${code}, cours affectés : ${TEACHER_COURSES.join(', ')}.`,
      `Vous n'êtes pas affecté au cours ${code}.`);
    if (!findStudent(id)) throw new HttpError(404, 'not_found', `Aucun étudiant ${id}.`);

    // Le serveur revalide la saisie : le formulaire du navigateur peut etre contourne.
    const { note } = await readJsonBody(req);
    if (typeof note !== 'number' || Number.isNaN(note) || note < 0 || note > 20) {
      throw new HttpError(400, 'invalid_grade', 'La note doit être un nombre compris entre 0 et 20.');
    }
    setGrade(code, id, Math.round(note * 100) / 100);
    return { ok: true, cours: code, etudiant: id, note, checks: auth.checks };
  }],
];

async function handleApi(req, res, pathname) {
  for (const [method, pattern, handler] of ROUTES) {
    const match = pathname.match(pattern);
    if (!match) continue;
    if (req.method !== method) continue;
    const body = await handler(req, ...match.slice(1));
    return sendJson(res, 200, body);
  }
  throw new HttpError(404, 'not_found', `Route inconnue : ${req.method} ${pathname}`);
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
  const { pathname } = new URL(req.url, 'http://localhost');
  const started = Date.now();

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    await handleApi(req, res, pathname);
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
