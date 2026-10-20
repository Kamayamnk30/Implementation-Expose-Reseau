/**
 * UniPortal - Logique applicative
 * ==========================================================================
 * Un seul module pour les trois pages ; l'attribut data-page du <body>
 * choisit l'initialisation a executer :
 *   - landing   : boutons de connexion
 *   - callback  : traitement du retour Auth0
 *   - dashboard : page protegee, vue par role et inspecteur JWT
 *
 * Les donnees de notes sont fictives et stockees en memoire. Dans une vraie
 * plateforme, elles seraient servies par une API metier qui valide l'access
 * token et verifie, a chaque requete, que l'utilisateur a le droit de voir ou
 * modifier la ressource demandee (§3.9).
 */

import {
  isConfigured,
  login,
  logout,
  handleCallback,
  isAuthenticated,
  getIdToken,
  getAccessToken,
  decodeJWT,
  getUserRole,
  requireAuth,
  ROLES,
  ROLES_NAMESPACE,
} from './auth.js';

/* ==========================================================================
   Utilitaires
   ========================================================================== */

/** Echappe une valeur avant insertion dans le HTML (protection XSS, §3.6.3). */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Convertit un timestamp Unix (secondes) en date lisible en francais. */
function formatTimestamp(seconds) {
  return new Date(seconds * 1000).toLocaleString('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

/** Formate une duree en secondes : "2 h 05 min", "4 min 12 s". */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}

/** Affiche un message bref en bas de l'ecran. */
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

/** Classe CSS de la pastille de note selon la valeur sur 20. */
function gradeClass(note) {
  if (note === null || note === undefined || Number.isNaN(note)) return 'grade--none';
  if (note >= 14) return 'grade--good';
  if (note >= 10) return 'grade--mid';
  return 'grade--low';
}

function formatGrade(note) {
  return (note === null || note === undefined) ? '-' : note.toFixed(2).replace('.', ',');
}

/* ==========================================================================
   Donnees fictives (remplacent les reponses de l'API metier)
   ========================================================================== */

/** Notes de l'etudiant connecte : GET /api/notes/me (§3.4, etape 6). */
const STUDENT_GRADES = [
  { code: 'RES301', matiere: 'Administration réseau', enseignant: 'M. Diallo', coef: 4, note: 15.5 },
  { code: 'SEC302', matiere: 'Sécurité des systèmes', enseignant: 'Mme Nguyen', coef: 3, note: 13.25 },
  { code: 'WEB303', matiere: 'Développement web', enseignant: 'M. Martin', coef: 3, note: 16 },
  { code: 'BDD304', matiere: 'Bases de données', enseignant: 'Mme Kouassi', coef: 2, note: 11 },
  { code: 'SYS305', matiere: 'Systèmes d\'exploitation', enseignant: 'M. Bernard', coef: 2, note: 8.75 },
  { code: 'ANG306', matiere: 'Anglais technique', enseignant: 'Mme Smith', coef: 1, note: null },
];

/** Etudiants du cours de l'enseignant : GET /api/cours/RES301/etudiants. */
const TEACHER_COURSE = { code: 'RES301', intitule: 'Administration réseau' };
const COURSE_STUDENTS = [
  { id: 'E2024-014', nom: 'Awa Traoré', groupe: 'TD1', note: 15.5 },
  { id: 'E2024-027', nom: 'Lucas Petit', groupe: 'TD1', note: 12 },
  { id: 'E2024-031', nom: 'Inès Benali', groupe: 'TD2', note: null },
  { id: 'E2024-042', nom: 'Moussa Keita', groupe: 'TD2', note: 9.5 },
  { id: 'E2024-058', nom: 'Chloé Laurent', groupe: 'TD1', note: null },
  { id: 'E2024-063', nom: 'Yann Mbappe', groupe: 'TD2', note: 17.25 },
];

/* ==========================================================================
   Page d'accueil
   ========================================================================== */

async function initLanding() {
  const notice = document.getElementById('config-notice');
  if (!isConfigured()) notice?.classList.add('is-visible');

  document.querySelectorAll('[data-action="login"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!isConfigured()) {
        notice?.classList.add('is-visible');
        notice?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      try {
        btn.disabled = true;
        await login();
      } catch (e) {
        btn.disabled = false;
        console.error('[app] login :', e);
        alert(e.message);
      }
    });
  });

  // Si une session existe deja, le bouton de la navbar mene au tableau de bord.
  if (!isConfigured()) return;
  try {
    if (await isAuthenticated()) {
      const navBtn = document.querySelector('.navbar [data-action="login"]');
      if (navBtn) {
        const link = document.createElement('a');
        link.href = 'dashboard.html';
        link.className = navBtn.className;
        link.textContent = 'Mon espace';
        navBtn.replaceWith(link);
      }
    }
  } catch (e) {
    console.warn('[app] session non verifiable :', e);
  }
}

/* ==========================================================================
   Page de callback
   ========================================================================== */

/**
 * Pistes de diagnostic associees aux erreurs courantes, d'apres la methode
 * de depannage du §3.7.7 et le tableau du §3.9.
 */
function callbackHint(error) {
  const msg = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  if (msg.includes('state')) {
    return 'Le state ne correspond pas : la transaction a expiré ou la page a été rechargée. Relancez la connexion depuis l\'accueil (§3.4, étape 2).';
  }
  if (msg.includes('callback') || msg.includes('redirect')) {
    return 'Comparez l\'URL de cette page aux "Allowed Callback URLs" de l\'application Auth0 : elles doivent être identiques (§3.9, erreur après connexion).';
  }
  if (msg.includes('access_denied') || msg.includes('unauthorized')) {
    return 'Auth0 a refusé l\'accès : vérifiez la connexion activée pour l\'application, le consentement ou une Action qui bloque la connexion (§3.3.5).';
  }
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('sdk')) {
    return 'Le navigateur ne joint pas le tenant : vérifiez DNS, HTTPS, proxy et pare-feu sur TCP/443 (§3.7.7, étapes 2 et 3).';
  }
  return 'Identifiez l\'étape qui échoue, puis consultez Monitoring > Logs dans le tableau de bord Auth0 (§3.7.7).';
}

async function initCallback() {
  try {
    const appState = await handleCallback();
    document.getElementById('callback-text').textContent = 'Jetons reçus et validés. Redirection vers votre espace...';
    window.location.replace(appState.targetUrl || 'dashboard.html');
  } catch (e) {
    console.error('[app] callback :', e);
    document.getElementById('callback-spinner').style.display = 'none';
    document.getElementById('callback-title').textContent = 'Connexion interrompue';
    document.getElementById('callback-text').textContent = '';
    document.getElementById('callback-error-message').textContent = e.message || String(e);
    document.getElementById('callback-error-hint').textContent = callbackHint(e);
    document.getElementById('callback-error').classList.add('is-visible');
    document.getElementById('callback-back').style.display = 'inline-flex';
  }
}

/* ==========================================================================
   Tableau de bord
   ========================================================================== */

async function initDashboard() {
  if (!isConfigured()) {
    window.location.replace('index.html');
    return;
  }

  const user = await requireAuth();
  const role = getUserRole(user);

  renderUserBar(user, role);
  if (role === ROLES.ENSEIGNANT) renderTeacherView();
  else renderStudentView();

  document.querySelector('[data-action="logout"]').addEventListener('click', () => logout());

  document.body.classList.remove('is-loading');
  await initJwtInspector();
}

/** En-tete : avatar, nom, email et role. */
function renderUserBar(user, role) {
  const avatar = document.getElementById('user-avatar');
  const name = user.name || user.nickname || user.email || 'Utilisateur';

  if (user.picture) {
    const img = document.createElement('img');
    img.src = user.picture;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { avatar.textContent = initials(name); };
    avatar.appendChild(img);
  } else {
    avatar.textContent = initials(name);
  }

  document.getElementById('user-name').textContent = name;
  document.getElementById('user-email').textContent = user.email || '';
  document.getElementById('user-role').textContent = role === ROLES.ENSEIGNANT ? 'Enseignant' : 'Étudiant';
}

function initials(name) {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

/** Vue etudiant : tableau des notes et moyenne ponderee. */
function renderStudentView() {
  const graded = STUDENT_GRADES.filter((g) => g.note !== null);
  const totalCoef = graded.reduce((sum, g) => sum + g.coef, 0);
  const moyenne = totalCoef ? graded.reduce((sum, g) => sum + g.note * g.coef, 0) / totalCoef : null;
  const valides = graded.filter((g) => g.note >= 10).length;

  const rows = STUDENT_GRADES.map((g) => `
    <tr>
      <td><strong>${escapeHtml(g.code)}</strong></td>
      <td>${escapeHtml(g.matiere)}</td>
      <td>${escapeHtml(g.enseignant)}</td>
      <td class="num">${g.coef}</td>
      <td class="num"><span class="grade ${gradeClass(g.note)}">${formatGrade(g.note)}</span></td>
    </tr>`).join('');

  document.getElementById('espace').innerHTML = `
    <div class="panel__head">
      <div>
        <span class="eyebrow">Espace étudiant</span>
        <h2>Mes notes - Semestre 5</h2>
        <p>Seules vos propres notes sont affichées : l'API filtre par la claim <code>sub</code> du jeton.</p>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="stat__label">Moyenne</div><div class="stat__value">${formatGrade(moyenne)}</div></div>
      <div class="stat"><div class="stat__label">Matières</div><div class="stat__value">${STUDENT_GRADES.length}</div></div>
      <div class="stat"><div class="stat__label">Validées</div><div class="stat__value">${valides}</div></div>
      <div class="stat"><div class="stat__label">En attente</div><div class="stat__value">${STUDENT_GRADES.length - graded.length}</div></div>
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>Code</th><th>Matière</th><th>Enseignant</th><th class="num">Coef.</th><th class="num">Note /20</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <p class="muted-note">Données fictives. En production, si un étudiant remplaçait son identifiant dans l'URL, l'API
    devrait refuser la requête (403), même avec un jeton valide (§3.9).</p>`;
}

/** Vue enseignant : liste des etudiants du cours et saisie de notes. */
function renderTeacherView() {
  const container = document.getElementById('espace');

  const render = () => {
    const saisies = COURSE_STUDENTS.filter((s) => s.note !== null).length;
    const rows = COURSE_STUDENTS.map((s, i) => `
      <tr>
        <td><strong>${escapeHtml(s.id)}</strong></td>
        <td>${escapeHtml(s.nom)}</td>
        <td>${escapeHtml(s.groupe)}</td>
        <td class="num"><span class="grade ${gradeClass(s.note)}">${formatGrade(s.note)}</span></td>
        <td>
          <form class="grade-form" data-index="${i}">
            <label class="field">
              <span class="sr-only">Note de ${escapeHtml(s.nom)}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              <input type="number" name="note" min="0" max="20" step="0.25" placeholder="/20" required>
            </label>
            <button class="btn btn--primary btn--sm" type="submit">Saisir</button>
          </form>
        </td>
      </tr>`).join('');

    container.innerHTML = `
      <div class="panel__head">
        <div>
          <span class="eyebrow">Espace enseignant</span>
          <h2>${escapeHtml(TEACHER_COURSE.code)} - ${escapeHtml(TEACHER_COURSE.intitule)}</h2>
          <p>Le rôle « enseignant » reçu dans le jeton débloque la saisie pour les cours qui vous sont affectés.</p>
        </div>
      </div>

      <div class="stats">
        <div class="stat"><div class="stat__label">Étudiants</div><div class="stat__value">${COURSE_STUDENTS.length}</div></div>
        <div class="stat"><div class="stat__label">Notes saisies</div><div class="stat__value">${saisies}</div></div>
        <div class="stat"><div class="stat__label">À saisir</div><div class="stat__value">${COURSE_STUDENTS.length - saisies}</div></div>
        <div class="stat"><div class="stat__label">Groupes</div><div class="stat__value">2</div></div>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>N° étudiant</th><th>Nom</th><th>Groupe</th><th class="num">Note</th><th class="num">Saisie</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <p class="muted-note">Simulation : la note est enregistrée en mémoire. En production, l'appel
      PUT /api/cours/${escapeHtml(TEACHER_COURSE.code)}/notes porterait l'access token ; l'API vérifierait le rôle et
      l'affectation au cours avant d'écrire (§3.5.3, §3.9).</p>`;

    container.querySelectorAll('.grade-form').forEach((form) => {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const index = Number(form.dataset.index);
        const value = Number(form.elements.note.value);
        if (Number.isNaN(value) || value < 0 || value > 20) return;
        COURSE_STUDENTS[index].note = value;
        showToast(`Note de ${COURSE_STUDENTS[index].nom} enregistrée : ${formatGrade(value)} / 20`);
        render();
      });
    });
  };

  render();
}

/* ==========================================================================
   Inspecteur JWT
   ========================================================================== */

/** Description pedagogique des claims les plus courantes. */
const CLAIM_DESCRIPTIONS = {
  iss: 'Émetteur : le tenant Auth0. L\'API doit vérifier qu\'il correspond au domaine attendu.',
  sub: 'Sujet : identifiant unique et stable de l\'utilisateur (connexion|id).',
  aud: 'Audience : destinataire du jeton. clientId pour l\'ID token, identifiant de l\'API pour l\'access token.',
  iat: 'Émis le (issued at).',
  exp: 'Expire le : au-delà, le jeton doit être refusé.',
  nbf: 'Non valide avant (not before).',
  auth_time: 'Moment de l\'authentification réelle de l\'utilisateur.',
  nonce: 'Valeur aléatoire liée à la requête /authorize : protège contre le rejeu.',
  sid: 'Identifiant de session Auth0, utilisé pour la déconnexion.',
  azp: 'Partie autorisée : client qui a demandé le jeton.',
  scope: 'Scopes accordés : droits liés à l\'accès à l\'API.',
  permissions: 'Permissions RBAC de l\'API (si l\'option est activée sur l\'API).',
  name: 'Nom affichable de l\'utilisateur.',
  nickname: 'Pseudonyme.',
  email: 'Adresse email.',
  email_verified: 'L\'adresse a-t-elle été vérifiée ?',
  picture: 'URL de l\'avatar.',
  updated_at: 'Dernière mise à jour du profil.',
  [ROLES_NAMESPACE]: 'Claim personnalisée injectée par l\'Action post-login : rôles RBAC de l\'utilisateur.',
};

const TIMESTAMP_CLAIMS = ['iat', 'exp', 'nbf', 'auth_time'];

const TOKEN_PURPOSE = {
  id: 'ID token : décrit le résultat de l\'authentification pour UniPortal. Son audience est le clientId ; il ne sert pas à appeler une API (§3.6.1).',
  access: 'Access token : autorise l\'appel à l\'API métier. Son audience est l\'identifiant de l\'API ; c\'est lui qui part dans l\'en-tête Authorization (§3.6.1).',
};

let expiryTimer = null;

async function initJwtInspector() {
  const tabs = document.querySelectorAll('.tab[data-token]');
  const tokens = {};

  try { tokens.id = await getIdToken(); } catch (e) { tokens.id = e; }
  try { tokens.access = await getAccessToken(); } catch (e) { tokens.access = e; }

  const show = (kind) => {
    tabs.forEach((t) => {
      const active = t.dataset.token === kind;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.getElementById('jwt-purpose').textContent = TOKEN_PURPOSE[kind];
    renderToken(tokens[kind]);
  };

  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.token)));
  show('id');
}

/** Affiche un jeton : brut colore, trois parties decodees, claims, expiration. */
function renderToken(token) {
  const target = document.getElementById('jwt-content');
  clearInterval(expiryTimer);

  if (!token || token instanceof Error) {
    target.innerHTML = `<div class="empty-state">Jeton indisponible : ${escapeHtml(token?.message || 'aucun jeton en cache')}.</div>`;
    return;
  }

  let jwt;
  try {
    jwt = decodeJWT(token);
  } catch (e) {
    target.innerHTML = `<div class="empty-state">${escapeHtml(e.message)} Vérifiez que l'audience de l'API est configurée (README, étape 6).</div>`;
    return;
  }

  const [h, p, s] = jwt.parts.map(escapeHtml);

  target.innerHTML = `
    <div class="expiry" id="jwt-expiry"></div>

    <div class="jwt-label">Jeton encodé</div>
    <pre class="jwt-raw"><span class="jwt-h">${h}</span><span class="jwt-dot">.</span><span class="jwt-p">${p}</span><span class="jwt-dot">.</span><span class="jwt-s">${s}</span></pre>

    <div class="jwt-parts">
      <div class="jwt-part jwt-part--header">
        <div class="jwt-part__head">Header <small>algorithme et type</small></div>
        <pre>${escapeHtml(JSON.stringify(jwt.header, null, 2))}</pre>
      </div>
      <div class="jwt-part jwt-part--payload">
        <div class="jwt-part__head">Payload <small>claims</small></div>
        <pre>${renderPayload(jwt.payload)}</pre>
      </div>
      <div class="jwt-part jwt-part--signature">
        <div class="jwt-part__head">Signature <small>${escapeHtml(jwt.header.alg || '')}</small></div>
        <pre>${escapeHtml(signatureFormula(jwt.header.alg))}

${s}</pre>
      </div>
    </div>

    <div class="claims">
      <div class="jwt-label">Lecture des claims</div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Claim</th><th>Valeur</th><th>Signification</th></tr></thead>
          <tbody>${renderClaimRows(jwt.payload)}</tbody>
        </table>
      </div>
    </div>`;

  startExpiryIndicator(jwt.payload);
}

/** JSON du payload avec les timestamps annotes en date lisible. */
function renderPayload(payload) {
  return JSON.stringify(payload, null, 2)
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*"([^"]+)":\s*(\d+),?$/);
      const safe = escapeHtml(line);
      if (match && TIMESTAMP_CLAIMS.includes(match[1])) {
        return `${safe}  <span class="ts">// ${escapeHtml(formatTimestamp(Number(match[2])))}</span>`;
      }
      return safe;
    })
    .join('\n');
}

function renderClaimRows(payload) {
  return Object.entries(payload).map(([key, value]) => {
    let display = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (TIMESTAMP_CLAIMS.includes(key) && typeof value === 'number') {
      display = `${value} (${formatTimestamp(value)})`;
    }
    return `
      <tr>
        <td><code>${escapeHtml(key)}</code></td>
        <td><code>${escapeHtml(display)}</code></td>
        <td>${escapeHtml(CLAIM_DESCRIPTIONS[key] || 'Claim spécifique au tenant ou au fournisseur.')}</td>
      </tr>`;
  }).join('');
}

function signatureFormula(alg) {
  if (alg === 'RS256') {
    return 'RSASHA256(\n  base64UrlEncode(header) + "." + base64UrlEncode(payload),\n  clé privée du tenant\n)\n// Vérifiable avec la clé publique : /.well-known/jwks.json';
  }
  if (alg === 'HS256') {
    return 'HMACSHA256(\n  base64UrlEncode(header) + "." + base64UrlEncode(payload),\n  secret partagé\n)';
  }
  return `Signature ${alg || 'inconnue'}`;
}

/** Indicateur d'expiration mis a jour chaque seconde. */
function startExpiryIndicator(payload) {
  const el = document.getElementById('jwt-expiry');
  if (!payload.exp) {
    el.className = 'expiry expiry--soon';
    el.textContent = 'Ce jeton ne contient pas de claim exp.';
    return;
  }

  const lifetime = payload.iat ? payload.exp - payload.iat : null;

  const tick = () => {
    const remaining = payload.exp - Date.now() / 1000;
    const ratio = lifetime ? Math.max(0, Math.min(1, remaining / lifetime)) : 1;

    let state = 'valid';
    let text = `Jeton valide - expire dans ${formatDuration(remaining)} (${formatTimestamp(payload.exp)})`;
    if (remaining <= 0) {
      state = 'expired';
      text = `Jeton expiré depuis ${formatDuration(-remaining)} : une API doit le refuser (401).`;
    } else if (ratio < 0.1 || remaining < 300) {
      state = 'soon';
      text = `Expiration proche - ${formatDuration(remaining)} restantes. Le SDK le renouvellera via le refresh token.`;
    }

    el.className = `expiry expiry--${state}`;
    el.innerHTML = `<span>${escapeHtml(text)}</span><span class="expiry__bar" aria-hidden="true"><span style="width:${(ratio * 100).toFixed(1)}%"></span></span>`;

    if (remaining <= 0) clearInterval(expiryTimer);
  };

  tick();
  expiryTimer = setInterval(tick, 1000);
}

/* ==========================================================================
   Point d'entree
   ========================================================================== */

const PAGES = {
  landing: initLanding,
  callback: initCallback,
  dashboard: initDashboard,
};

const init = PAGES[document.body.dataset.page];
if (init) {
  init().catch((e) => console.error('[app] initialisation :', e));
}
