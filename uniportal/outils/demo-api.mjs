#!/usr/bin/env node
/**
 * UniPortal - Demonstration des controles de l'API (ligne de commande)
 * ==========================================================================
 * Rejoue six scenarios contre l'API pour montrer, pendant l'expose, comment
 * elle traite un access token (§3.4 etape 6, §3.6.2, §3.9). L'interface du
 * site ne montre rien de tout cela : c'est ce script qui le rend visible.
 *
 * Usage :
 *   node outils/demo-api.mjs <access_token> [id_token] [--url http://localhost:8080]
 *
 * Recuperer les jetons apres s'etre connecte sur le site :
 *   - onglet Reseau des outils de developpement : requete /api/..., en-tete
 *     "Authorization: Bearer <access_token>" ;
 *   - ou console du navigateur, sur le tableau de bord :
 *       const k = Object.keys(localStorage).find((x) => x.startsWith('@@auth0spajs@@') && !x.includes('@@user@@'));
 *       const { body } = JSON.parse(localStorage.getItem(k));
 *       console.log(body.access_token, body.id_token);
 *
 * Aucune dependance : Node.js 18 ou plus (fetch natif).
 */

const ROLES_NAMESPACE = 'https://uniportal.example.com/roles';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const BASE = urlIndex >= 0 ? args.splice(urlIndex, 2)[1] : 'http://localhost:8080';
const [accessToken, idToken] = args;

if (!accessToken) {
  console.error('Usage : node outils/demo-api.mjs <access_token> [id_token] [--url http://localhost:8080]');
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Outils JWT (decodage seulement : la verification appartient a l'API)
   -------------------------------------------------------------------------- */

const b64url = {
  decode: (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')),
  encode: (o) => Buffer.from(JSON.stringify(o)).toString('base64url'),
};

function decode(token) {
  const [h, p, s] = token.split('.');
  return { header: b64url.decode(h), payload: b64url.decode(p), parts: [h, p, s] };
}

/**
 * Jeton falsifie : roles remplaces, signature d'origine conservee. Le jeton
 * reste parfaitement lisible ; seule la verification de signature cote API
 * le demasque (§3.6.2).
 */
function forge(token) {
  const { payload, parts } = decode(token);
  const forged = { ...payload, [ROLES_NAMESPACE]: ['professeur', 'admin'] };
  return `${parts[0]}.${b64url.encode(forged)}.${parts[2]}`;
}

/* --------------------------------------------------------------------------
   Scenarios
   -------------------------------------------------------------------------- */

const { payload } = decode(accessToken);
const roles = payload[ROLES_NAMESPACE] || [];
const isProf = roles.includes('professeur');
const ownPath = isProf ? '/api/classes/2B/matieres/MATHS/eleves' : '/api/eleves/me/bulletin';

const scenarios = [
  { titre: 'Requête légitime', attendu: 200, method: 'GET', path: ownPath, token: accessToken },
  { titre: 'Sans jeton', attendu: 401, method: 'GET', path: ownPath, token: null },
  { titre: 'Jeton falsifié (rôles modifiés)', attendu: 401, method: 'GET', path: ownPath, token: forge(accessToken) },
  { titre: 'ID token au lieu de l\'access token', attendu: 401, method: 'GET', path: ownPath, token: idToken, skip: !idToken },
  isProf
    ? { titre: 'Matière non enseignée (Français)', attendu: 403, method: 'GET', path: '/api/classes/2B/matieres/FRA/eleves', token: accessToken }
    : { titre: 'Bulletin d\'un autre élève', attendu: 403, method: 'GET', path: '/api/eleves/EL-2B-02/bulletin', token: accessToken },
  isProf
    ? { titre: 'Route réservée aux élèves', attendu: 403, method: 'GET', path: '/api/eleves/me/bulletin', token: accessToken }
    : { titre: 'Saisie d\'une note par un élève', attendu: 403, method: 'PUT', path: '/api/classes/2B/matieres/MATHS/notes/EL-2B-02',
      body: { trimestre: 3, note: 20 }, token: accessToken },
];

console.log(`API : ${BASE}`);
console.log(`Jeton : sub=${payload.sub}, rôles=${JSON.stringify(roles)}, aud=${JSON.stringify(payload.aud)}\n`);

let conformes = 0;
for (const s of scenarios) {
  if (s.skip) {
    console.log(`  --   ${s.titre} : ignoré (passer l'ID token en second argument)`);
    continue;
  }
  const headers = { Accept: 'application/json' };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  if (s.body) headers['Content-Type'] = 'application/json';

  let status;
  let data = {};
  try {
    const res = await fetch(BASE + s.path, { method: s.method, headers, body: s.body ? JSON.stringify(s.body) : undefined });
    status = res.status;
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`API injoignable (${BASE}) : ${e.message}`);
    process.exit(2);
  }

  const ok = status === s.attendu;
  if (ok) conformes += 1;
  const echec = (data.checks || []).find((c) => !c.ok);
  console.log(`  ${ok ? 'OK' : '!!'}  ${status}  ${s.titre}`);
  console.log(`         ${s.method} ${s.path}`);
  if (echec) console.log(`         contrôle en échec : ${echec.name} - ${echec.detail}`);
  else if (data.message) console.log(`         ${data.message}`);
}

const joues = scenarios.filter((s) => !s.skip).length;
console.log(`\n${conformes}/${joues} scénarios conformes au résultat attendu.`);
process.exit(conformes === joues ? 0 : 3);
