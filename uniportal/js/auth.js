/**
 * UniPortal - Module d'authentification Auth0
 * ==========================================================================
 * Ce module encapsule le SDK @auth0/auth0-spa-js (v2.1.3), charge depuis le
 * CDN Auth0 dans chaque page HTML avant ce fichier. Le SDK expose l'objet
 * global `window.auth0`.
 *
 * Toutes les references "§3.x" renvoient au chapitre 3 de l'expose :
 * "Presentation generale d'Auth0".
 *
 * Rappel (§3.1.4) : Auth0 verifie l'identite, mais ne connait pas les regles
 * metier. Les controles faits ici dans le navigateur servent l'experience
 * utilisateur ; la vraie protection des donnees appartient a l'API (§3.4,
 * etape 6 et §3.9).
 */

/* --------------------------------------------------------------------------
   Configuration
   Remplacer les placeholders par les valeurs de l'application SPA creee
   dans le tableau de bord Auth0 (voir README.md, etapes 2 a 6).
   Le domaine identifie le tenant (§3.3.1) ; le clientId identifie
   l'application cliente (§3.3.2). Aucun secret n'apparait ici : une SPA est
   un client public, elle ne doit jamais embarquer de client_secret (§3.6.3).
   -------------------------------------------------------------------------- */
const AUTH0_CONFIG = {
  domain: 'VOTRE-TENANT.auth0.com',
  clientId: 'VOTRE_CLIENT_ID',
  // Identifiant de l'API metier declaree dans Auth0 (README, etape 6).
  // Il devient la claim "aud" de l'access token (§3.6.2, controle d'audience).
  audience: 'https://api.uniportal.example.com',
};

/**
 * Namespace des claims personnalisees ajoutees par l'Action post-login
 * (§3.3.5). Auth0 impose une URL pour eviter les collisions avec les claims
 * standard OIDC (sub, iss, aud...).
 */
export const ROLES_NAMESPACE = 'https://uniportal.example.com/roles';

/** Roles applicatifs reconnus par UniPortal (§3.5.3, RBAC). */
export const ROLES = {
  ETUDIANT: 'etudiant',
  ENSEIGNANT: 'enseignant',
};

/* URL construites relativement a la page courante : le projet fonctionne
   aussi bien a la racine d'un serveur que dans un sous-dossier. Ces adresses
   doivent figurer exactement dans les "Allowed Callback/Logout URLs" (§3.4,
   etape 2 : une URI de redirection non autorisee est rejetee). */
const CALLBACK_URL = new URL('callback.html', window.location.href).href;
const HOME_URL = new URL('index.html', window.location.href).href;

/** Instance unique du client Auth0 (patron singleton). */
let auth0Client = null;

/**
 * Indique si les placeholders de configuration ont ete remplaces.
 * Permet d'afficher un message clair plutot qu'une erreur reseau opaque
 * (resolution DNS impossible du faux domaine, §3.7.1).
 * @returns {boolean}
 */
export function isConfigured() {
  return !AUTH0_CONFIG.domain.startsWith('VOTRE-') && !AUTH0_CONFIG.clientId.startsWith('VOTRE_');
}

/**
 * Initialise le client Auth0 (une seule fois par page).
 *
 * Cote reseau : la creation du client ne declenche pas de redirection. Si une
 * session existe deja dans le cache local, le SDK peut renouveler les jetons
 * en arriere-plan par un POST HTTPS vers /oauth/token avec le refresh token
 * (§3.6.1). Sinon, aucune requete n'est envoyee tant que login() n'est pas
 * appele.
 *
 * Options choisies :
 * - PKCE : active par defaut dans auth0-spa-js v2 pour le flux Authorization
 *   Code. Le SDK genere un code_verifier aleatoire et envoie son empreinte
 *   SHA-256 (code_challenge) a /authorize (§3.4, etape 4).
 * - cacheLocation 'localstorage' : les jetons survivent au rechargement de la
 *   page et a l'ouverture d'un nouvel onglet. Contrepartie : un script injecte
 *   (XSS) pourrait les lire ; d'ou l'importance de la protection des jetons
 *   (§3.6.3).
 * - useRefreshTokens : le SDK demande le scope offline_access et utilise la
 *   rotation des refresh tokens au lieu d'une iframe cachee, plus robuste face
 *   au blocage des cookies tiers (§3.6.1).
 *
 * @returns {Promise<object>} le client Auth0 initialise
 */
export async function initAuth0() {
  if (auth0Client) return auth0Client;

  if (!isConfigured()) {
    throw new Error('Configuration Auth0 manquante : renseignez domain et clientId dans js/auth.js (voir README.md).');
  }
  if (!window.auth0 || typeof window.auth0.createAuth0Client !== 'function') {
    throw new Error('Le SDK Auth0 n\'a pas pu etre charge depuis cdn.auth0.com. Verifiez la connexion, le DNS, le proxy ou le pare-feu (§3.7.3).');
  }

  auth0Client = await window.auth0.createAuth0Client({
    domain: AUTH0_CONFIG.domain,
    clientId: AUTH0_CONFIG.clientId,
    cacheLocation: 'localstorage',
    useRefreshTokens: true,
    authorizationParams: {
      redirect_uri: CALLBACK_URL,
      audience: AUTH0_CONFIG.audience,
      // openid : obligatoire pour OIDC, declenche l'emission d'un ID token (§3.2.3)
      // profile / email : claims d'identite (name, picture, email)
      // offline_access : ajoute automatiquement par useRefreshTokens
      scope: 'openid profile email',
    },
  });

  return auth0Client;
}

/**
 * Demarre la connexion via Universal Login (§3.3.3).
 *
 * Cote reseau (§3.4, etapes 1 et 2) : le SDK genere state, nonce et le couple
 * code_verifier / code_challenge, les memorise temporairement, puis redirige
 * le navigateur (GET HTTPS, TCP/443) vers :
 *   https://<tenant>/authorize?response_type=code&client_id=...
 *     &redirect_uri=.../callback.html&scope=openid profile email offline_access
 *     &audience=...&state=...&nonce=...&code_challenge=...&code_challenge_method=S256
 * L'application ne voit jamais le mot de passe : il est saisi sur le domaine
 * Auth0 (§3.3.3).
 *
 * @param {object} [options]
 * @param {string} [options.connection] force une connexion precise, par exemple
 *   'google-oauth2' pour la connexion sociale (§3.3.4)
 * @returns {Promise<void>}
 */
export async function login(options = {}) {
  const client = await initAuth0();
  const authorizationParams = {};
  if (options.connection) authorizationParams.connection = options.connection;

  await client.loginWithRedirect({
    authorizationParams,
    // appState voyage avec la requete (lie au parametre state) et nous est
    // rendu au retour : on y place la page de destination.
    appState: { targetUrl: 'dashboard.html' },
  });
}

/**
 * Deconnecte l'utilisateur.
 *
 * Cote reseau (§3.7.4) : le SDK vide son cache local (jetons de l'application)
 * puis redirige vers https://<tenant>/v2/logout?client_id=...&returnTo=...
 * pour fermer aussi la session Auth0. Il faut distinguer la session de
 * l'application de la session du fournisseur : sans cet appel, un nouveau
 * clic sur "Se connecter" reconnecterait l'utilisateur sans mot de passe (SSO).
 * L'URL returnTo doit figurer dans les "Allowed Logout URLs".
 *
 * @returns {Promise<void>}
 */
export async function logout() {
  const client = await initAuth0();
  await client.logout({ logoutParams: { returnTo: HOME_URL } });
}

/**
 * Traite le retour d'Auth0 sur callback.html.
 *
 * Cote reseau (§3.4, etapes 4 et 5) :
 * 1. Auth0 a redirige le navigateur (HTTP 302) vers
 *    callback.html?code=...&state=...
 * 2. Le SDK compare le state recu a celui memorise (protection CSRF).
 * 3. Il envoie un POST HTTPS vers /oauth/token avec grant_type=authorization_code,
 *    le code et le code_verifier : Auth0 recalcule le SHA-256 et refuse
 *    l'echange s'il ne correspond pas au code_challenge initial (PKCE).
 * 4. Il recoit id_token, access_token et refresh_token, verifie le nonce et
 *    les claims de l'ID token, puis les stocke dans le cache.
 * Enfin, l'URL est nettoyee pour ne pas laisser le code dans l'historique.
 *
 * @returns {Promise<{targetUrl: string}>} l'appState transmis par login()
 */
export async function handleCallback() {
  const client = await initAuth0();
  const params = new URLSearchParams(window.location.search);

  // Auth0 peut renvoyer une erreur explicite (acces refuse, URI non autorisee...)
  if (params.has('error')) {
    const err = new Error(params.get('error_description') || params.get('error'));
    err.code = params.get('error');
    throw err;
  }
  if (!params.has('code') || !params.has('state')) {
    throw new Error('Parametres code et state absents : cette page doit etre atteinte via une redirection Auth0.');
  }

  const result = await client.handleRedirectCallback();
  window.history.replaceState({}, document.title, window.location.pathname);
  return result.appState || { targetUrl: 'dashboard.html' };
}

/**
 * Indique si une session applicative valide existe.
 *
 * Cote reseau : lecture du cache local ; si l'access token a expire, le SDK
 * peut tenter un renouvellement silencieux par refresh token (§3.6.1).
 *
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated() {
  const client = await initAuth0();
  return client.isAuthenticated();
}

/**
 * Renvoie le profil OIDC de l'utilisateur.
 *
 * Les informations proviennent des claims de l'ID token deja valide par le
 * SDK (§3.2.3) : aucune requete supplementaire vers /userinfo n'est
 * necessaire (§3.7.4).
 *
 * @returns {Promise<object|undefined>} sub, name, email, picture et claims personnalisees
 */
export async function getUserProfile() {
  const client = await initAuth0();
  return client.getUser();
}

/**
 * Renvoie l'ID token brut (JWT encode).
 *
 * L'ID token decrit le resultat de l'authentification pour ce client ; son
 * audience est le clientId. Il ne doit pas servir a appeler une API (§3.6.1).
 *
 * @returns {Promise<string|null>}
 */
export async function getIdToken() {
  const client = await initAuth0();
  const claims = await client.getIdTokenClaims();
  return claims ? claims.__raw : null;
}

/**
 * Renvoie un access token valide pour l'API metier.
 *
 * Cote reseau : si le jeton en cache est encore valide, aucune requete n'est
 * envoyee. Sinon le SDK effectue un POST /oauth/token avec
 * grant_type=refresh_token ; Auth0 emet un nouveau couple de jetons et
 * invalide l'ancien refresh token (rotation, §3.6.1).
 * Ce jeton serait transmis a l'API dans l'en-tete
 * "Authorization: Bearer <token>" ; l'API doit verifier signature, emetteur,
 * audience, expiration et permissions (§3.4, etape 6 et §3.6.2).
 *
 * @returns {Promise<string>}
 */
export async function getAccessToken() {
  const client = await initAuth0();
  return client.getTokenSilently();
}

/**
 * Decode un JWT sans verifier sa signature (usage pedagogique).
 *
 * Un JWT est forme de trois segments Base64URL separes par des points :
 * en-tete . contenu . signature (§3.2.5). Le decodage montre que le contenu
 * est lisible par tous : il n'est pas chiffre. Decoder ne prouve rien ; seul
 * le backend, en verifiant la signature avec les cles publiques du tenant
 * (/.well-known/jwks.json), peut faire confiance au jeton (§3.6.2).
 *
 * @param {string} token JWT compact
 * @returns {{raw: string, parts: string[], header: object, payload: object, signature: string}}
 */
export function decodeJWT(token) {
  if (typeof token !== 'string') throw new Error('Jeton absent.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Ce jeton n\'est pas un JWT (3 segments attendus) : il est probablement opaque.');

  return {
    raw: token,
    parts,
    header: JSON.parse(base64UrlDecode(parts[0])),
    payload: JSON.parse(base64UrlDecode(parts[1])),
    signature: parts[2],
  };
}

/**
 * Decode une chaine Base64URL (RFC 4648 §5) en texte UTF-8.
 * @param {string} segment
 * @returns {string}
 */
function base64UrlDecode(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Determine le role applicatif de l'utilisateur (RBAC, §3.5.3).
 *
 * Les roles sont attribues dans Auth0 (User Management > Roles) puis injectes
 * dans les jetons par l'Action post-login sous la claim ROLES_NAMESPACE
 * (§3.3.5). Le role le plus privilegie l'emporte ; a defaut, le moindre
 * privilege s'applique et l'utilisateur est traite en etudiant.
 *
 * @param {object} user profil renvoye par getUserProfile()
 * @returns {'etudiant'|'enseignant'}
 */
export function getUserRole(user) {
  const roles = (user && Array.isArray(user[ROLES_NAMESPACE])) ? user[ROLES_NAMESPACE] : [];
  if (roles.includes(ROLES.ENSEIGNANT)) return ROLES.ENSEIGNANT;
  return ROLES.ETUDIANT;
}

/**
 * Garde d'acces pour les pages protegees.
 *
 * Correspond a l'etape 1 du §3.4 : si aucune session valable n'existe,
 * l'utilisateur est renvoye vers la page publique. Il s'agit d'un confort
 * d'interface, pas d'une securite : un attaquant peut toujours lire le HTML.
 * Les donnees sensibles ne doivent etre servies que par une API qui valide
 * l'access token (§3.9).
 *
 * @returns {Promise<object>} le profil de l'utilisateur connecte
 */
export async function requireAuth() {
  let authenticated = false;
  try {
    authenticated = await isAuthenticated();
  } catch (e) {
    console.error('[auth] verification de session impossible :', e);
  }

  if (!authenticated) {
    window.location.replace(HOME_URL);
    // Promesse jamais resolue : la page s'arrete le temps de la redirection.
    return new Promise(() => {});
  }
  return getUserProfile();
}
