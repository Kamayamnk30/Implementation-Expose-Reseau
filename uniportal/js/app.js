/**
 * UniPortal - Logique applicative
 * ==========================================================================
 * Un seul module pour les trois pages ; l'attribut data-page du <body>
 * choisit l'initialisation a executer :
 *   - landing   : boutons de connexion
 *   - callback  : traitement du retour Auth0
 *   - dashboard : page protegee, bulletin (eleve) ou saisie (professeur)
 *
 * L'interface reste volontairement neutre : aucune notion technique n'est
 * affichee. Les details utiles au diagnostic (erreurs Auth0, refus de l'API,
 * pistes du §3.7.7) sont ecrits dans la console du navigateur.
 *
 * Les resultats sont servis par l'API metier du dossier server/ (npm start).
 * Elle valide l'access token et verifie, a chaque requete, que l'utilisateur
 * a le droit de voir ou de modifier la ressource demandee (§3.9). Sans
 * backend (simple serveur de fichiers), le tableau de bord utilise des
 * donnees locales d'exemple.
 */

import {
  isConfigured,
  login,
  logout,
  handleCallback,
  isAuthenticated,
  getAccessToken,
  getUserRole,
  requireAuth,
  ROLES,
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

function formatGrade(note) {
  return (note === null || note === undefined) ? '-' : note.toFixed(2).replace('.', ',');
}

function gradeClass(note) {
  if (note === null || note === undefined) return 'grade--none';
  if (note >= 14) return 'grade--good';
  if (note >= 10) return 'grade--mid';
  return 'grade--low';
}

const trimestreLabel = (t) => (t === 1 ? '1er trimestre' : `${t}e trimestre`);
const rangLabel = (r) => (r === 1 ? '1er' : `${r}e`);

function initials(name) {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

/** Affiche un message bref en bas de l'ecran. */
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

/** Branche les boutons data-action="login" sur login() (Universal Login, §3.3.3). */
function bindLoginButtons() {
  document.querySelectorAll('[data-action="login"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!isConfigured()) {
        console.warn('[UniPortal] Auth0 non configure : renseignez domain et clientId dans js/auth.js (README, etape 3).');
        showToast('La connexion est momentanément indisponible. Veuillez réessayer plus tard.');
        return;
      }
      try {
        btn.disabled = true;
        await login();
      } catch (e) {
        btn.disabled = false;
        console.error('[UniPortal] login :', e);
        showToast('La connexion est momentanément indisponible. Veuillez réessayer plus tard.');
      }
    });
  });
}

/* ==========================================================================
   Acces a l'API metier
   ========================================================================== */

/** true lorsque l'API repond sur /api/sante. */
let apiMode = false;

/**
 * Envoie une requete a l'API metier.
 *
 * Cote reseau : requete HTTP vers la meme origine ; l'access token part dans
 * l'en-tete "Authorization: Bearer <token>" (§3.4, etape 6). L'API le valide
 * (signature, iss, aud, exp - §3.6.2) puis applique les droits : 200, 401
 * (jeton refuse) ou 403 (action interdite). Les refus sont detailles dans la
 * console, jamais a l'ecran.
 *
 * @param {string} path chemin, par exemple /api/eleves/me/bulletin
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.body] corps JSON
 * @returns {Promise<{status: number, ok: boolean, data: object}>} status 0 si le reseau a echoue
 */
async function apiRequest(path, { method = 'GET', body } = {}) {
  let token;
  try {
    // Renvoie le jeton en cache, ou le renouvelle par refresh token (rotation, §3.6.1).
    token = await getAccessToken();
  } catch (e) {
    console.warn('[UniPortal] access token indisponible, session expiree :', e.message);
    return { status: 401, ok: false, data: { error: 'login_required' } };
  }

  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    console.error('[UniPortal] API injoignable :', e);
    return { status: 0, ok: false, data: {} };
  }

  let data = {};
  try { data = await response.json(); } catch { /* reponse sans corps JSON */ }
  if (!response.ok) {
    console.warn(`[UniPortal] ${method} ${path} -> ${response.status}`, data.message || '', data.checks || '');
  }
  return { status: response.status, ok: response.ok, data };
}

/** Detecte la presence de l'API (route publique, sans jeton). */
async function detectApi() {
  try {
    const res = await fetch('/api/sante', { headers: { Accept: 'application/json' } });
    const data = await res.json();
    return res.ok && data.status === 'ok';
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------
   Donnees locales (sans backend), au meme format que les reponses de l'API
   -------------------------------------------------------------------------- */

const LOCAL_MATIERES = [
  ['FRA', 'Français', 3, 'Mme Ndiaye', [12.5, 13, 14]],
  ['MATHS', 'Mathématiques', 4, 'M. Diallo', [14, 15.5, null]],
  ['PC', 'Physique-Chimie', 3, 'M. Koné', [13.5, 14.5, 15]],
  ['SVT', 'Sciences de la vie et de la Terre', 2, 'Mme Bamba', [15, 14, null]],
  ['HG', 'Histoire-Géographie', 2, 'M. Sow', [11, 12.5, 13]],
  ['ANG', 'Anglais', 2, 'Mme Smith', [16, 16.5, 17]],
  ['ESP', 'Espagnol', 1, 'Mme García', [12, 13.5, null]],
  ['EPS', 'Éducation physique et sportive', 1, 'M. Camara', [17, 16, 16.5]],
];

function localBulletin(t) {
  const matieres = LOCAL_MATIERES.map(([code, nom, coef, professeur, notes]) => ({
    code, nom, coef, professeur, note: notes[t - 1], appreciation: notes[t - 1] === null ? null : 'Travail sérieux et régulier.',
    moyenneClasse: 12.4, min: 7.5, max: 17.5,
  }));
  const notees = matieres.filter((m) => m.note !== null);
  const coefs = notees.reduce((s, m) => s + m.coef, 0);
  const moyenne = coefs ? notees.reduce((s, m) => s + m.note * m.coef, 0) / coefs : null;
  return {
    eleve: { id: 'EL-2B-01', nom: '', classe: { code: '2B', nom: 'Seconde B' } },
    annee: '2025-2026', trimestre: t, complet: notees.length === matieres.length, matieres,
    moyenne, moyenneClasse: 12.4, rang: 3, effectif: 9,
    mention: moyenne >= 14 ? 'Compliments' : null, appreciationGenerale: 'Très bon travail, continuez ainsi.',
  };
}

const LOCAL_RELEVE = {
  classe: { code: '2B', nom: 'Seconde B' },
  matiere: { code: 'MATHS', nom: 'Mathématiques', coef: 4 },
  eleves: [
    ['EL-2B-01', 'Aminata Diop'], ['EL-2B-05', 'Chloé Bernard'], ['EL-2B-03', 'Fatou Sarr'], ['EL-2B-04', 'Ibrahim Touré'],
    ['EL-2B-07', 'Inès Benali'], ['EL-2B-02', 'Lucas Martin'], ['EL-2B-06', 'Moussa Keita'], ['EL-2B-08', 'Yann Kouassi'],
  ].map(([id, nom], i) => ({ id, nom, notes: { 1: 9 + i, 2: 9.5 + i, 3: null }, appreciations: {} })),
};

/**
 * Source de donnees du tableau de bord : l'API si elle repond, sinon les
 * donnees locales. Chaque methode renvoie { ok, data } ou { ok: false, status }.
 */
const dataSource = {
  async bulletin(t) {
    if (!apiMode) return { ok: true, data: localBulletin(t) };
    const res = await apiRequest(`/api/eleves/me/bulletin?trimestre=${t}`);
    return res.ok ? { ok: true, data: res.data } : { ok: false, status: res.status };
  },
  async affectations() {
    if (!apiMode) {
      return { ok: true, data: { affectations: [{ classe: LOCAL_RELEVE.classe, matiere: LOCAL_RELEVE.matiere }] } };
    }
    const res = await apiRequest('/api/professeurs/me/affectations');
    return res.ok ? { ok: true, data: res.data } : { ok: false, status: res.status };
  },
  async releve(classe, matiere, t) {
    if (!apiMode) {
      const eleves = LOCAL_RELEVE.eleves.map((e) => ({ id: e.id, nom: e.nom, note: e.notes[t], appreciation: e.appreciations[t] || null }));
      const notes = eleves.map((e) => e.note).filter((n) => n !== null);
      return { ok: true, data: {
        classe: LOCAL_RELEVE.classe, matiere: LOCAL_RELEVE.matiere, annee: '2025-2026', trimestre: t, eleves,
        moyenneClasse: notes.length ? notes.reduce((a, b) => a + b, 0) / notes.length : null, saisies: notes.length,
      } };
    }
    const res = await apiRequest(`/api/classes/${classe}/matieres/${matiere}/eleves?trimestre=${t}`);
    return res.ok ? { ok: true, data: res.data } : { ok: false, status: res.status };
  },
  async enregistrer(classe, matiere, eleveId, trimestre, note, appreciation) {
    if (!apiMode) {
      const e = LOCAL_RELEVE.eleves.find((x) => x.id === eleveId);
      e.notes[trimestre] = note;
      e.appreciations[trimestre] = appreciation;
      return { ok: true };
    }
    const res = await apiRequest(`/api/classes/${classe}/matieres/${matiere}/notes/${eleveId}`, {
      method: 'PUT', body: { trimestre, note, appreciation },
    });
    return res.ok ? { ok: true } : { ok: false, status: res.status, message: res.data.message };
  },
};

/* ==========================================================================
   Page d'accueil
   ========================================================================== */

async function initLanding() {
  bindLoginButtons();

  // Si une session Auth0 existe deja, le bouton de la barre mene a l'espace personnel.
  if (!isConfigured()) {
    console.info('[UniPortal] Auth0 non configure : la connexion est desactivee (README, etape 3).');
    return;
  }
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
    console.warn('[UniPortal] session non verifiable :', e);
  }
}

/* ==========================================================================
   Page de callback
   ========================================================================== */

/**
 * Piste de diagnostic associee a une erreur de callback, d'apres la methode
 * de depannage du §3.7.7 et le tableau du §3.9. Ecrite dans la console.
 */
function callbackHint(error) {
  const msg = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  if (msg.includes('state')) return 'State invalide : transaction expiree ou page rechargee. Relancer la connexion (§3.4, etape 2).';
  if (msg.includes('callback') || msg.includes('redirect')) return 'URL de retour absente des "Allowed Callback URLs" de l\'application Auth0 (§3.9).';
  if (msg.includes('access_denied') || msg.includes('unauthorized')) return 'Acces refuse par Auth0 : connexion non activee pour l\'application, consentement ou Action bloquante (§3.3.5).';
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('sdk')) return 'Tenant injoignable : verifier DNS, HTTPS, proxy et pare-feu sur TCP/443 (§3.7.7).';
  return 'Identifier l\'etape qui echoue, puis consulter Monitoring > Logs dans le tableau de bord Auth0 (§3.7.7).';
}

async function initCallback() {
  bindLoginButtons();
  try {
    const appState = await handleCallback();
    window.location.replace(appState.targetUrl || 'dashboard.html');
  } catch (e) {
    console.error('[UniPortal] callback Auth0 :', e);
    console.info('[UniPortal] piste :', callbackHint(e));
    document.getElementById('callback-spinner').style.display = 'none';
    document.getElementById('callback-title').textContent = 'Connexion interrompue';
    document.getElementById('callback-text').textContent = 'La connexion n\'a pas pu aboutir. Veuillez réessayer.';
    document.getElementById('callback-actions').classList.add('is-visible');
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
  apiMode = await detectApi();
  if (!apiMode) console.info('[UniPortal] API non detectee : donnees locales d\'exemple (lancer npm start).');

  renderUserMenu(user, role);
  document.querySelector('[data-action="logout"]').addEventListener('click', () => logout());
  document.body.classList.remove('is-loading');

  if (role === ROLES.PROFESSEUR) await initProfesseur();
  else if (role === ROLES.ELEVE) await initEleve(user);
  else renderMessage('Compte en attente d\'activation',
    'Votre profil n\'a pas encore été attribué par l\'établissement. Contactez le secrétariat, puis reconnectez-vous.');
}

function renderUserMenu(user, role) {
  const avatar = document.getElementById('user-avatar');
  const name = user.name || user.nickname || user.email || 'Utilisateur';
  if (user.picture) {
    const img = document.createElement('img');
    img.src = user.picture;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { img.remove(); avatar.textContent = initials(name); };
    avatar.appendChild(img);
  } else {
    avatar.textContent = initials(name);
  }
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-role').textContent = role === ROLES.PROFESSEUR ? 'Professeur' : role === ROLES.ELEVE ? 'Élève' : '';
}

/** Message plein cadre (compte en attente, erreur, session expiree). */
function renderMessage(title, text, action) {
  document.getElementById('espace').innerHTML = `
    <section class="card message">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(text)}</p>
      ${action ? `<button class="btn btn--primary" id="message-action">${escapeHtml(action.label)}</button>` : ''}
    </section>`;
  if (action) document.getElementById('message-action').addEventListener('click', action.onClick);
}

/**
 * Traduit un refus de l'API en message neutre. Le code HTTP et les controles
 * en echec sont deja dans la console (apiRequest).
 */
function renderApiError(status) {
  if (status === 401) {
    return renderMessage('Session expirée', 'Pour des raisons de sécurité, veuillez vous reconnecter.',
      { label: 'Se reconnecter', onClick: () => login() });
  }
  if (status === 403) {
    return renderMessage('Accès non autorisé',
      'Votre compte n\'a pas accès à ces informations. Contactez le secrétariat si vous pensez qu\'il s\'agit d\'une erreur.');
  }
  return renderMessage('Service momentanément indisponible', 'Veuillez réessayer dans quelques instants.',
    { label: 'Réessayer', onClick: () => window.location.reload() });
}

function trimestreTabs(active) {
  return `<div class="tabs" role="tablist" aria-label="Trimestre">${[1, 2, 3].map((t) => `
    <button class="tab${t === active ? ' is-active' : ''}" role="tab" aria-selected="${t === active}" data-trimestre="${t}">T${t}</button>`).join('')}
  </div>`;
}

/* --------------------------------------------------------------------------
   Vue eleve : bulletin
   -------------------------------------------------------------------------- */

async function initEleve(user) {
  let trimestre = 3;

  const render = async () => {
    const result = await dataSource.bulletin(trimestre);
    if (!result.ok) return renderApiError(result.status);
    const b = result.data;
    const nom = b.eleve.nom && b.eleve.nom !== 'Élève' ? b.eleve.nom : (user.name || '');

    const rows = b.matieres.map((m) => `
      <tr>
        <td><strong>${escapeHtml(m.nom)}</strong><span class="cell-sub">${escapeHtml(m.professeur)}</span></td>
        <td class="num">${m.coef}</td>
        <td class="num"><span class="grade ${gradeClass(m.note)}">${formatGrade(m.note)}</span></td>
        <td class="num muted">${formatGrade(m.moyenneClasse)}</td>
        <td class="num muted nowrap">${formatGrade(m.min)} / ${formatGrade(m.max)}</td>
        <td class="appr">${m.note === null ? '<span class="muted">Non publiée</span>' : escapeHtml(m.appreciation || '')}</td>
      </tr>`).join('');

    document.getElementById('espace').innerHTML = `
      <section class="card panel bulletin">
        <div class="panel__head">
          <div>
            <span class="eyebrow">Année scolaire ${escapeHtml(b.annee)} - ${escapeHtml(b.eleve.classe.nom)}</span>
            <h1 class="panel__title">Bulletin du ${trimestreLabel(b.trimestre)}</h1>
            <p>${escapeHtml(nom)}</p>
          </div>
          <div class="panel__tools no-print">
            ${trimestreTabs(trimestre)}
            <button class="btn btn--ghost btn--sm" data-action="print">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              Imprimer
            </button>
          </div>
        </div>

        ${b.complet ? '' : '<p class="info">Trimestre en cours : certaines moyennes ne sont pas encore publiées.</p>'}

        <div class="stats">
          <div class="stat stat--primary"><div class="stat__label">Moyenne générale</div><div class="stat__value">${formatGrade(b.moyenne)}</div></div>
          <div class="stat"><div class="stat__label">Moyenne de la classe</div><div class="stat__value">${formatGrade(b.moyenneClasse)}</div></div>
          <div class="stat"><div class="stat__label">Rang</div><div class="stat__value">${b.rang ? `${rangLabel(b.rang)}<small> / ${b.effectif}</small>` : '-'}</div></div>
          <div class="stat"><div class="stat__label">Distinction</div><div class="stat__value stat__value--text">${escapeHtml(b.mention || '-')}</div></div>
        </div>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>Matière</th><th class="num">Coef.</th><th class="num">Moyenne</th><th class="num">Classe</th><th class="num">Min / Max</th><th>Appréciation</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>

        <div class="appreciation">
          <h2>Appréciation générale</h2>
          <p>${escapeHtml(b.appreciationGenerale || 'Disponible après le conseil de classe.')}</p>
        </div>
      </section>`;

    document.querySelectorAll('[data-trimestre]').forEach((btn) => btn.addEventListener('click', () => {
      trimestre = Number(btn.dataset.trimestre);
      render();
    }));
    document.querySelector('[data-action="print"]').addEventListener('click', () => window.print());
  };

  await render();
}

/* --------------------------------------------------------------------------
   Vue professeur : saisie des moyennes et appreciations
   -------------------------------------------------------------------------- */

async function initProfesseur() {
  const aff = await dataSource.affectations();
  if (!aff.ok) return renderApiError(aff.status);
  const { affectations } = aff.data;
  if (!affectations.length) {
    return renderMessage('Aucune classe', 'Aucune classe ne vous est encore attribuée pour cette année scolaire.');
  }

  let index = 0;
  let trimestre = 3;

  const render = async () => {
    const { classe, matiere } = affectations[index];
    const result = await dataSource.releve(classe.code, matiere.code, trimestre);
    if (!result.ok) return renderApiError(result.status);
    const r = result.data;

    const options = affectations.map((a, i) => `
      <option value="${i}"${i === index ? ' selected' : ''}>${escapeHtml(a.classe.nom)} - ${escapeHtml(a.matiere.nom)}</option>`).join('');

    const rows = r.eleves.map((e) => `
      <tr>
        <td><strong>${escapeHtml(e.nom)}</strong></td>
        <td class="num"><span class="grade ${gradeClass(e.note)}">${formatGrade(e.note)}</span></td>
        <td>
          <form class="entry-form" data-id="${escapeHtml(e.id)}" data-nom="${escapeHtml(e.nom)}">
            <label class="field field--note">
              <span class="sr-only">Moyenne de ${escapeHtml(e.nom)}</span>
              <input type="number" name="note" min="0" max="20" step="0.25" placeholder="/20" value="${e.note ?? ''}">
            </label>
            <label class="field field--appr">
              <span class="sr-only">Appréciation pour ${escapeHtml(e.nom)}</span>
              <input type="text" name="appreciation" maxlength="300" placeholder="Appréciation" value="${escapeHtml(e.appreciation || '')}">
            </label>
            <button class="btn btn--primary btn--sm" type="submit">Enregistrer</button>
          </form>
        </td>
      </tr>`).join('');

    document.getElementById('espace').innerHTML = `
      <section class="card panel">
        <div class="panel__head">
          <div>
            <span class="eyebrow">Année scolaire ${escapeHtml(r.annee)}</span>
            <h1 class="panel__title">Saisie des moyennes - ${trimestreLabel(trimestre)}</h1>
            <p>${escapeHtml(r.classe.nom)}, ${escapeHtml(r.matiere.nom)} (coefficient ${r.matiere.coef})</p>
          </div>
          <div class="panel__tools">
            <label class="select">
              <span class="sr-only">Classe et matière</span>
              <select id="affectation">${options}</select>
            </label>
            ${trimestreTabs(trimestre)}
          </div>
        </div>

        <div class="stats stats--3">
          <div class="stat"><div class="stat__label">Élèves</div><div class="stat__value">${r.eleves.length}</div></div>
          <div class="stat"><div class="stat__label">Moyennes saisies</div><div class="stat__value">${r.saisies}<small> / ${r.eleves.length}</small></div></div>
          <div class="stat"><div class="stat__label">Moyenne de la classe</div><div class="stat__value">${formatGrade(r.moyenneClasse)}</div></div>
        </div>

        <div class="table-wrap">
          <table class="table table--entry">
            <thead><tr><th>Élève</th><th class="num">Moyenne</th><th>Saisie</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="muted-note">Les moyennes enregistrées sont immédiatement visibles par les élèves.</p>
      </section>`;

    document.getElementById('affectation').addEventListener('change', (e) => { index = Number(e.target.value); render(); });
    document.querySelectorAll('[data-trimestre]').forEach((btn) => btn.addEventListener('click', () => {
      trimestre = Number(btn.dataset.trimestre);
      render();
    }));

    document.querySelectorAll('.entry-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const raw = form.elements.note.value.trim();
        const note = raw === '' ? null : Number(raw);
        if (note !== null && (Number.isNaN(note) || note < 0 || note > 20)) {
          showToast('La moyenne doit être comprise entre 0 et 20.');
          return;
        }
        const appreciation = form.elements.appreciation.value.trim();
        const button = form.querySelector('button');
        button.disabled = true;

        const saved = await dataSource.enregistrer(classe.code, matiere.code, form.dataset.id, trimestre, note, appreciation);
        if (saved.ok) {
          showToast(`Moyenne de ${form.dataset.nom} enregistrée.`);
          await render();
        } else if (saved.status === 401 || saved.status === 403) {
          renderApiError(saved.status);
        } else {
          button.disabled = false;
          showToast('L\'enregistrement a échoué. Veuillez réessayer.');
        }
      });
    });
  };

  await render();
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
  init().catch((e) => console.error('[UniPortal] initialisation :', e));
}
