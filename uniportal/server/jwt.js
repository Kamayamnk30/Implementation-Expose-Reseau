/**
 * UniPortal API - Validation des access tokens Auth0
 * ==========================================================================
 * Implementation volontairement explicite, sans bibliotheque, des controles
 * listes au §3.6.2 : signature, emetteur, audience, expiration. Les
 * permissions sont verifiees ensuite, route par route, dans server.js.
 *
 * Chaque controle est consigne dans un tableau `checks` renvoye au client :
 * la console API du tableau de bord affiche ainsi quel controle a echoue.
 *
 * En production, on prefererait une bibliotheque eprouvee (jose,
 * express-oauth2-jwt-bearer) ; le principe reste exactement celui-ci.
 */

import { createPublicKey, verify } from 'node:crypto';

/** Algorithme unique accepte : celui configure sur l'API Auth0 (README, etape 6). */
const EXPECTED_ALG = 'RS256';

/** Duree de conservation des cles publiques en cache (ms). */
const JWKS_CACHE_TTL = 10 * 60 * 1000;

/** Delai minimal entre deux telechargements declenches par un kid inconnu (ms). */
const JWKS_MIN_REFRESH = 30 * 1000;

/**
 * Erreur de validation : se traduit par une reponse HTTP 401 (RFC 6750).
 */
export class TokenError extends Error {
  /**
   * @param {string} message description lisible, renvoyee au client
   * @param {Array<object>} checks controles effectues jusqu'a l'echec
   */
  constructor(message, checks) {
    super(message);
    this.name = 'TokenError';
    this.checks = checks;
  }
}

/**
 * Erreur d'infrastructure : les cles du tenant sont injoignables.
 * Se traduit par une reponse HTTP 502 : ce n'est pas la faute du client.
 * Flux "API -> metadonnees/cles", HTTPS sortant (§3.7.3).
 */
export class JwksError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JwksError';
  }
}

/** Decode un segment Base64URL en Buffer. */
function base64UrlToBuffer(segment) {
  return Buffer.from(segment, 'base64url');
}

/** Decode un segment Base64URL contenant du JSON. */
function parseSegment(segment, label) {
  try {
    return JSON.parse(base64UrlToBuffer(segment).toString('utf8'));
  } catch {
    throw new Error(`${label} illisible : JSON Base64URL attendu.`);
  }
}

/**
 * Cree une fonction de validation liee a un tenant et a une API.
 *
 * @param {object} options
 * @param {string} options.domain domaine du tenant, par exemple uniportal-demo.eu.auth0.com
 * @param {string} options.audience identifiant de l'API (claim "aud" attendue)
 * @param {number} [options.leeway=60] tolerance d'horloge en secondes (§3.7.6 : horloges synchronisees)
 * @returns {(token: string) => Promise<{header: object, payload: object, checks: Array<object>}>}
 */
export function createVerifier({ domain, audience, leeway = 60 }) {
  // L'emetteur Auth0 se termine toujours par une barre oblique.
  const issuer = `https://${domain}/`;
  // Cles publiques du tenant, publiees au format JWKS (JSON Web Key Set).
  const jwksUri = `${issuer}.well-known/jwks.json`;

  let keys = new Map();
  let fetchedAt = 0;

  /**
   * Telecharge les cles publiques du tenant.
   * Cote reseau : GET HTTPS sortant vers le tenant (DNS, TCP/443, TLS).
   * Si un pare-feu bloque ce flux, aucune requete ne peut etre validee.
   */
  async function loadKeys() {
    let response;
    try {
      response = await fetch(jwksUri, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
      throw new JwksError(`Clés publiques injoignables (${jwksUri}) : ${e.message}. Vérifiez DNS, proxy et pare-feu sortant (§3.7.3).`);
    }
    if (!response.ok) {
      throw new JwksError(`Le tenant a répondu ${response.status} pour ${jwksUri}. Vérifiez AUTH0_DOMAIN.`);
    }

    const { keys: jwks = [] } = await response.json();
    keys = new Map(
      jwks
        .filter((k) => k.kty === 'RSA' && (!k.use || k.use === 'sig') && k.kid)
        .map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]),
    );
    fetchedAt = Date.now();
  }

  /**
   * Renvoie la cle publique correspondant au kid de l'en-tete.
   * Un kid inconnu peut signifier une rotation de cle cote Auth0 : on
   * retelecharge alors le JWKS, en limitant la frequence pour qu'un
   * attaquant ne puisse pas faire marteler le tenant avec des kid inventes.
   * Si le tenant est injoignable mais que la cle est deja connue, on continue
   * avec la copie en cache : les jetons deja emis restent verifiables (§3.7.6).
   */
  async function getKey(kid) {
    const expired = Date.now() - fetchedAt > JWKS_CACHE_TTL;
    const canRefresh = Date.now() - fetchedAt > JWKS_MIN_REFRESH;
    if (expired || (!keys.has(kid) && canRefresh)) {
      try {
        await loadKeys();
      } catch (e) {
        if (!keys.has(kid)) throw e;
        console.warn(`[api] ${e.message} Cle "${kid}" reprise du cache.`);
      }
    }
    return keys.get(kid);
  }

  return async function verifyToken(token) {
    const checks = [];
    const pass = (name, detail) => checks.push({ name, ok: true, detail });
    const fail = (name, detail) => {
      checks.push({ name, ok: false, detail });
      throw new TokenError(detail, checks);
    };

    // 1. Structure : trois segments Base64URL (§3.2.5).
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) fail('Format', 'Le jeton n\'est pas un JWT : trois segments séparés par des points sont attendus.');

    let header;
    let payload;
    try {
      header = parseSegment(parts[0], 'En-tête');
      payload = parseSegment(parts[1], 'Contenu');
    } catch (e) {
      fail('Format', e.message);
    }
    pass('Format', 'JWT compact : en-tête, contenu et signature.');

    // 2. Algorithme : on n'accepte que RS256. Refuser "none" ou "HS256"
    //    empeche un attaquant de choisir un algorithme plus faible.
    if (header.alg !== EXPECTED_ALG) fail('Algorithme', `Algorithme "${header.alg}" refusé : seul ${EXPECTED_ALG} est accepté.`);
    pass('Algorithme', `${EXPECTED_ALG} (signature asymétrique RSA + SHA-256).`);

    // 3. Signature : verifiee avec la cle publique du tenant (§3.6.2).
    //    Toute modification de l'en-tete ou du contenu la rend invalide.
    const key = await getKey(header.kid);
    if (!key) fail('Signature', `Clé "${header.kid}" absente du JWKS du tenant : jeton émis par un autre serveur ?`);

    const signedData = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToBuffer(parts[2]);
    if (!verify('RSA-SHA256', signedData, key, signature)) {
      fail('Signature', 'Signature invalide : le jeton a été modifié ou n\'a pas été signé par ce tenant.');
    }
    pass('Signature', `Vérifiée avec la clé publique "${header.kid}" (${jwksUri}).`);

    // 4. Emetteur : le jeton doit provenir de notre tenant.
    if (payload.iss !== issuer) fail('Émetteur (iss)', `Émetteur "${payload.iss}" inattendu : ${issuer} attendu.`);
    pass('Émetteur (iss)', issuer);

    // 5. Audience : le jeton doit etre destine a cette API. Un ID token
    //    (aud = clientId) est refuse ici : il n'est pas fait pour ca (§3.6.1).
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(audience)) fail('Audience (aud)', `Audience ${JSON.stringify(payload.aud)} : ce jeton n'est pas destiné à ${audience}.`);
    pass('Audience (aud)', audience);

    // 6. Validite temporelle, avec une tolerance pour les ecarts d'horloge.
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number') fail('Expiration (exp)', 'Claim exp absente.');
    if (now > payload.exp + leeway) fail('Expiration (exp)', `Jeton expiré depuis ${now - payload.exp} s.`);
    if (typeof payload.nbf === 'number' && now + leeway < payload.nbf) fail('Expiration (exp)', 'Jeton pas encore valide (nbf).');
    pass('Expiration (exp)', `Valide encore ${payload.exp - now} s.`);

    return { header, payload, checks };
  };
}
