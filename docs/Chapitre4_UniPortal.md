# Chapitre 4 - Mise en œuvre : UniPortal, une plateforme universitaire sécurisée par Auth0

Le chapitre 3 a présenté Auth0 sous l'angle des principes : notions d'identité, protocoles, architecture, déroulement d'une connexion, sécurité des jetons et implications réseau. Ce chapitre en propose une mise en œuvre concrète. Il décrit UniPortal, une application de consultation et de saisie de notes construite pour l'exposé, qui reprend l'étude de cas du §3.9 et rend observables, dans un navigateur, les mécanismes décrits jusqu'ici.

L'objectif n'est pas de livrer un produit fini, mais un support de démonstration fidèle aux standards : chaque requête échangée est réelle, chaque contrôle de sécurité est visible, et chaque choix technique renvoie à la section du chapitre 3 qui le justifie.

## 4.1 Contexte et objectifs

### 4.1.1 Du cas d'étude à la démonstration

Le §3.9 imagine une plateforme où les étudiants consultent leurs notes et où les enseignants saisissent celles des cours qu'ils assurent. Il souligne une leçon centrale : Auth0 établit le contexte d'identité, mais c'est l'API qui doit appliquer le contrôle d'accès aux données. UniPortal transforme ce scénario en application fonctionnelle, composée de trois éléments :

- un **frontend** web, de type Single Page Application (SPA), qui délègue la connexion à Auth0 ;
- un **tenant Auth0**, configuré avec une application, une API, des connexions, des rôles et une Action ;
- une **API métier** légère, qui valide les jetons reçus et décide de l'accès aux notes.

### 4.1.2 Objectifs

Les objectifs poursuivis sont de deux ordres.

**Objectifs pédagogiques.** Permettre à l'auditoire de :

- suivre pas à pas le flux Authorization Code avec PKCE (§3.4) dans les outils de développement du navigateur ;
- distinguer concrètement l'ID token de l'access token (§3.6.1) ;
- constater qu'un JWT est lisible par tous, mais que seule la vérification de sa signature permet de lui faire confiance (§3.2.5, §3.6.2) ;
- observer la différence entre une erreur 401 (jeton refusé) et une erreur 403 (action interdite), qui structure le tableau de dépannage du §3.9 ;
- relier chaque échange aux notions réseau du §3.7 : DNS, HTTPS/TLS sur TCP/443, flux sortants, endpoints.

**Objectifs techniques.** Produire une application :

- conforme aux recommandations actuelles pour les applications publiques : flux Authorization Code avec PKCE, sans secret dans le navigateur ;
- sans framework ni dépendance applicative, afin que chaque mécanisme reste lisible dans le code ;
- documentée en français, chaque fonction renvoyant à la section correspondante du chapitre 3 ;
- utilisable sur ordinateur comme sur mobile.

### 4.1.3 Périmètre

UniPortal couvre la connexion (mot de passe, connexion sociale Google, MFA optionnelle), la déconnexion, deux rôles (étudiant et enseignant), la consultation et la saisie de notes, ainsi que deux outils pédagogiques : une **console API** et un **inspecteur JWT**. Les données sont fictives et conservées en mémoire. La gestion d'un rôle administrateur, la persistance en base de données et le déploiement en production sont hors périmètre ; ils sont discutés au §4.11.

## 4.2 Architecture générale

### 4.2.1 Vue d'ensemble

L'architecture reprend la vue logique du §3.3.6. Le navigateur exécute la SPA, qui dialogue avec le tenant Auth0 pour authentifier l'utilisateur, puis avec l'API UniPortal pour accéder aux données. L'API ne contacte Auth0 que pour récupérer les clés publiques qui lui permettent de vérifier les signatures.

![Figure 4.1 - Architecture logique d'UniPortal](images/fig-4-1-architecture.png)
*Figure 4.1 - Architecture logique d'UniPortal*

Trois flux réseau se dégagent, tous en HTTPS dans un déploiement réel :

1. **Navigateur vers Auth0** : redirections et échanges du flux d'authentification (étapes 2 à 5 du §3.4).
2. **Navigateur vers API** : chargement des pages, puis appels `/api` portant l'access token dans l'en-tête `Authorization`.
3. **API vers Auth0** : téléchargement du jeu de clés publiques (JWKS), mis en cache.

Le serveur UniPortal sert à la fois les fichiers du frontend et l'API. Frontend et API partagent donc la même origine, ce qui évite toute configuration CORS et garde les URL de retour déclarées dans Auth0 identiques en développement.

### 4.2.2 Composants

*Tableau 4.1 - Composants d'UniPortal et correspondance avec le chapitre 3*

| Composant | Fichier(s) | Rôle | Référence |
| --- | --- | --- | --- |
| Page d'accueil | `index.html` | Présentation, bouton de connexion, illustration du flux | §3.3.3, §3.4 |
| Page de retour | `callback.html` | Reçoit le code, l'échange contre les jetons | §3.4 étape 4 |
| Tableau de bord | `dashboard.html` | Vue par rôle, console API, inspecteur JWT | §3.5.3, §3.6 |
| Module d'authentification | `js/auth.js` | Encapsule le SDK Auth0 : connexion, jetons, rôles | §3.3.2 (SDK) |
| Logique applicative | `js/app.js` | Rendu des pages, appels d'API, outils pédagogiques | §3.9 |
| Serveur HTTP | `server/server.js` | Fichiers statiques, routage, autorisation | §3.3.2 (API métier) |
| Validation des jetons | `server/jwt.js` | Signature, algorithme, émetteur, audience, expiration | §3.6.2 |
| Données | `server/data.js` | Cours, fiches étudiantes, notes en mémoire | §3.9 |
| Tenant Auth0 | Configuration | Application SPA, API, connexions, rôles, Action | §3.3.1 à §3.3.5 |

### 4.2.3 Arborescence

```
uniportal/
├── index.html          Page d'accueil publique
├── callback.html       Retour du flux Auth0
├── dashboard.html      Espace protégé
├── css/style.css       Styles (mobile-first)
├── js/auth.js          Module Auth0
├── js/app.js           Logique applicative
├── server/server.js    Serveur HTTP et routes /api
├── server/jwt.js       Validation des access tokens
├── server/data.js      Données de démonstration
├── package.json        Script npm start
└── README.md           Guide de configuration
```

### 4.2.4 Choix technologiques

*Tableau 4.2 - Choix technologiques et justification*

| Choix | Justification | Contrepartie |
| --- | --- | --- |
| JavaScript vanilla, sans framework | Le code reste lisible par un public non spécialiste ; aucune étape de compilation | Moins de structure qu'avec React ou Angular |
| SDK officiel `auth0-spa-js` 2.1.3 | Implémente PKCE, `state`, `nonce` et le renouvellement des jetons selon les standards | Dépendance chargée depuis le CDN d'Auth0 |
| Modules ES natifs | Fonctions réellement exportées (`import` / `export`), sans outil de build | Exige un serveur HTTP : `file://` ne fonctionne pas |
| Node.js sans dépendance (`node:http`, `node:crypto`) | Chaque contrôle du §3.6.2 est écrit explicitement ; rien à installer | En production, une bibliothèque éprouvée serait préférable |
| Données en mémoire | Démonstration autonome, sans base à installer | Données perdues à l'arrêt du serveur |
| CSS pur, mobile-first | Aucune ressource externe hormis la police ; rendu identique partout | Pas de bibliothèque de composants |

## 4.3 Configuration du tenant Auth0

La configuration du tenant concrétise les composants du §3.3. Elle est décrite pas à pas dans le `README.md` du projet ; cette section en explique les choix.

### 4.3.1 Tenant et application SPA

Un tenant (§3.3.1) est créé, par exemple `uniportal-demo`, avec le domaine `uniportal-demo.eu.auth0.com`. L'application UniPortal y est déclarée de type **Single Page Web Application**. Ce type correspond à un **client public** : le code s'exécute dans le navigateur et ne peut garder aucun secret. Le *Client Secret* n'est donc jamais copié dans le projet, conformément au §3.6.3 ; c'est PKCE qui protège l'échange du code.

Seuls deux identifiants publics sont reportés dans `js/auth.js` : le domaine du tenant et le *Client ID*.

*Tableau 4.3 - URL autorisées de l'application (développement local)*

| Paramètre | Valeur | Rôle |
| --- | --- | --- |
| Allowed Callback URLs | `http://localhost:8080/callback.html` | Seule adresse où Auth0 renverra le code |
| Allowed Logout URLs | `http://localhost:8080/index.html` | Adresse de retour après déconnexion |
| Allowed Web Origins | `http://localhost:8080` | Origine autorisée pour le renouvellement silencieux |
| Allowed Origins (CORS) | `http://localhost:8080` | Origine autorisée pour les appels au tenant |

Auth0 compare ces adresses à l'identique. Une différence de port, de chemin ou de barre oblique finale provoque une erreur `Callback URL mismatch`. Cette rigueur est voulue : accepter une adresse arbitraire permettrait de détourner le code vers un site contrôlé par un attaquant (§3.4, étape 2).

Dans les paramètres avancés, les *grant types* **Authorization Code** et **Refresh Token** sont activés, ainsi que la **rotation des refresh tokens** (§3.6.1).

### 4.3.2 Connexions

Trois méthodes illustrent les connecteurs du §3.3.4 et les méthodes du §3.5.1 :

- **Base de données** (`Username-Password-Authentication`) : comptes gérés par Auth0 ;
- **Google** : connexion sociale, sans mot de passe local ;
- **MFA**, facultative : mot de passe à usage unique, exigé toujours ou selon le risque (§3.5.2).

Pour l'application, ces choix sont transparents : Universal Login présente les méthodes activées, et UniPortal reçoit dans tous les cas le même type de jetons.

### 4.3.3 API et audience

Une API nommée *UniPortal API* est déclarée avec l'identifiant `https://api.uniportal.example.com` et l'algorithme de signature **RS256**. Cet identifiant n'est pas une adresse réseau : c'est la valeur que portera la claim `aud` (audience) des access tokens. Sans API déclarée, Auth0 émettrait un access token opaque, inutilisable pour une validation locale. L'option *Allow Offline Access* est activée pour autoriser les refresh tokens.

L'algorithme RS256 est asymétrique : Auth0 signe avec une clé privée qu'il est seul à détenir, et n'importe quel serveur peut vérifier la signature avec la clé publique correspondante, publiée dans le JWKS du tenant. L'API UniPortal n'a donc besoin d'aucun secret partagé.

### 4.3.4 Rôles et Action post-login

Deux rôles sont créés dans *User Management > Roles* : `etudiant` et `enseignant` (§3.5.3). Par défaut, Auth0 ne place pas les rôles dans les jetons. Une Action (§3.3.5), déclenchée après chaque connexion réussie, les y ajoute :

```js
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://uniportal.example.com/roles';
  const roles = (event.authorization && event.authorization.roles) || [];

  // ID token : lu par la SPA pour adapter l'interface
  api.idToken.setCustomClaim(namespace, roles);

  // Access token : lu par l'API métier pour autoriser ou refuser
  api.accessToken.setCustomClaim(namespace, roles);

  // Facultatif : nom affiché par l'API
  api.accessToken.setCustomClaim('https://uniportal.example.com/name', event.user.name);
};
```

Le nom de la claim est une URL, appelée *namespace*. Auth0 l'impose pour éviter toute collision avec les claims standard d'OpenID Connect (`sub`, `iss`, `aud`, etc.). Les rôles sont écrits dans les deux jetons, car ils servent à deux destinataires différents : la SPA, qui adapte l'affichage, et l'API, qui décide.

> **À retenir :** une Action s'exécute au milieu du flux de connexion. Un code lent ou un appel à un service indisponible ralentit ou bloque toutes les connexions (§3.3.5). L'Action d'UniPortal se limite donc à des opérations locales.

## 4.4 Déroulement d'une connexion dans UniPortal

### 4.4.1 Vue séquentielle

La figure 4.2 reprend les six étapes du §3.4 et les projette sur les quatre acteurs d'UniPortal.

![Figure 4.2 - Diagramme de séquence : connexion et appel d'API](images/fig-4-2-sequence.png)
*Figure 4.2 - Diagramme de séquence : connexion et appel d'API*

### 4.4.2 Les six étapes en détail

**Étape 1 - Demande d'accès.** L'utilisateur clique sur « Se connecter ». Aucune session n'existant, la fonction `login()` de `js/auth.js` appelle `loginWithRedirect()`. Avant toute requête, le SDK génère dans le navigateur trois valeurs aléatoires : le `code_verifier` de PKCE, le paramètre `state` et le `nonce`. Il calcule l'empreinte du verifier :

```
code_verifier  = chaîne aléatoire (43 à 128 caractères)
code_challenge = BASE64URL(SHA256(code_verifier))
```

**Étape 2 - Redirection vers Auth0.** Le navigateur résout le nom du tenant (DNS, §3.7.1), établit une connexion TLS (§3.7.2) et ouvre l'endpoint d'autorisation :

```
GET /authorize?response_type=code
  &client_id=<CLIENT_ID>
  &redirect_uri=http://localhost:8080/callback.html
  &scope=openid profile email offline_access
  &audience=https://api.uniportal.example.com
  &code_challenge=E9Melhoa2Ow...&code_challenge_method=S256
  &state=<aléatoire>&nonce=<aléatoire>
Host: uniportal-demo.eu.auth0.com
```

Seule l'empreinte (`code_challenge`) circule ; le verifier reste dans le navigateur.

**Étape 3 - Vérification de l'utilisateur.** Universal Login (§3.3.3) présente les méthodes activées. L'utilisateur saisit ses identifiants ou choisit Google ; une étape MFA peut s'ajouter. Le mot de passe est transmis au domaine d'Auth0 et jamais à UniPortal.

**Étape 4 - Retour vers l'application.** Auth0 redirige le navigateur vers l'URL de retour autorisée :

```
HTTP/1.1 302 Found
Location: http://localhost:8080/callback.html?code=SplxlOB...&state=<même valeur>
```

La page `callback.html` appelle `handleCallback()`. Le SDK vérifie que le `state` reçu est celui qu'il avait émis, puis échange le code :

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=SplxlOB...
&code_verifier=dBjftJeZ4CVP...&client_id=<CLIENT_ID>
&redirect_uri=http://localhost:8080/callback.html
```

Auth0 recalcule `SHA256(code_verifier)` et le compare au `code_challenge` reçu à l'étape 2. Un attaquant qui aurait intercepté le code, sans le verifier, ne pourrait rien en faire.

**Étape 5 - Utilisation des jetons.** Auth0 répond :

```
HTTP/1.1 200 OK
{
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "v1.MjQ5...",
  "token_type": "Bearer",
  "expires_in": 86400
}
```

Le SDK valide l'ID token (signature, émetteur, audience, `nonce`, expiration), stocke les jetons, puis `callback.html` efface le code de l'historique et redirige vers le tableau de bord.

**Étape 6 - Contrôle par l'API.** Le tableau de bord demande les notes :

```
GET /api/notes/me
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

L'API valide le jeton, vérifie le rôle et retrouve la fiche de l'utilisateur grâce à la claim `sub`. Elle répond 200 avec les notes, 401 si le jeton est refusé ou 403 si l'action est interdite. Cette étape est détaillée au §4.6.

### 4.4.3 Rôle des paramètres de sécurité

*Tableau 4.4 - Paramètres de sécurité du flux*

| Paramètre | Généré par | Vérifié par | Menace écartée |
| --- | --- | --- | --- |
| `code_verifier` / `code_challenge` | SDK (navigateur) | Auth0, à l'échange du code | Interception du code d'autorisation |
| `state` | SDK | SDK, au retour sur `callback.html` | Falsification de requête (CSRF) sur le retour |
| `nonce` | SDK | SDK, dans l'ID token | Rejeu d'un ID token capturé |
| `redirect_uri` | Configuration | Auth0, liste blanche stricte | Détournement du code vers un tiers |
| Signature RS256 | Auth0 (clé privée) | SDK et API (clé publique) | Jeton fabriqué ou modifié |
| `aud` | Auth0 | API | Jeton destiné à un autre service |

### 4.4.4 Déconnexion

La fonction `logout()` vide le cache local des jetons, puis redirige vers `/v2/logout` avec l'adresse de retour. Le §3.7.4 distingue la session de l'application de la session du fournisseur. Sans l'appel à `/v2/logout`, la session Auth0 subsisterait, et un nouveau clic sur « Se connecter » reconnecterait l'utilisateur sans lui redemander son mot de passe.

## 4.5 Le frontend

### 4.5.1 Le module d'authentification

Le fichier `js/auth.js` isole tout ce qui concerne Auth0. Le reste de l'application ne manipule jamais le SDK directement. Chaque fonction est commentée (JSDoc) pour expliquer ce qui se passe côté réseau et protocole.

*Tableau 4.5 - Fonctions exportées par js/auth.js*

| Fonction | Effet | Trafic réseau |
| --- | --- | --- |
| `initAuth0()` | Crée le client Auth0 (singleton) | Éventuel renouvellement par refresh token |
| `login(options)` | Lance Universal Login ; `connection` peut forcer Google | Redirection vers `/authorize` |
| `handleCallback()` | Vérifie `state`, échange le code, nettoie l'URL | `POST /oauth/token` |
| `logout()` | Vide le cache, ferme la session Auth0 | Redirection vers `/v2/logout` |
| `isAuthenticated()` | Indique si une session valide existe | Éventuel renouvellement |
| `getUserProfile()` | Renvoie les claims de l'ID token | Aucun (pas d'appel à `/userinfo`) |
| `getIdToken()` | Renvoie l'ID token brut | Aucun |
| `getAccessToken()` | Renvoie un access token valide | `POST /oauth/token` si expiré (rotation) |
| `decodeJWT(token)` | Décode les trois parties, sans vérifier | Aucun |
| `getUserRole(user)` | Déduit le rôle de la claim des rôles | Aucun |
| `requireAuth()` | Redirige vers l'accueil si aucune session | Aucun |

### 4.5.2 Options du SDK

```js
auth0Client = await window.auth0.createAuth0Client({
  domain: AUTH0_CONFIG.domain,
  clientId: AUTH0_CONFIG.clientId,
  cacheLocation: 'localstorage',
  useRefreshTokens: true,
  authorizationParams: {
    redirect_uri: CALLBACK_URL,
    audience: AUTH0_CONFIG.audience,
    scope: 'openid profile email',
  },
});
```

*Tableau 4.6 - Options du SDK et justification*

| Option | Valeur | Justification | Point de vigilance |
| --- | --- | --- | --- |
| PKCE | Actif par défaut (v2) | Recommandé pour les clients publics (§3.4) | Aucun |
| `cacheLocation` | `localstorage` | La session survit au rechargement et aux nouveaux onglets | Un script injecté (XSS) pourrait lire les jetons (§3.6.3) |
| `useRefreshTokens` | `true` | Renouvellement sans iframe, robuste au blocage des cookies tiers | Exige la rotation côté tenant (§3.6.1) |
| `audience` | Identifiant de l'API | Obtient un access token JWT validable par l'API | Doit être identique dans Auth0 et dans le code |
| `scope` | `openid profile email` | `openid` déclenche OIDC ; le SDK ajoute `offline_access` | Ne demander que le nécessaire (§3.7.4) |

Les URL de retour sont calculées par rapport à la page courante (`new URL('callback.html', location.href)`). Le projet fonctionne ainsi à la racine d'un serveur comme dans un sous-dossier.

Une fonction `isConfigured()` détecte les valeurs d'exemple laissées dans la configuration. Dans ce cas, la page d'accueil affiche un bandeau explicite au lieu de laisser échouer une résolution DNS sur un domaine fictif.

### 4.5.3 Les pages

**Page d'accueil.** Elle présente le projet, les protocoles mis en œuvre et six fonctionnalités, chacune liée à sa section du chapitre 3. Elle illustre aussi le flux en six étapes avec les requêtes HTTP réellement échangées, ainsi que les garde-fous de sécurité.

![Figure 4.4 - Page d'accueil d'UniPortal](images/fig-4-4-accueil.png)
*Figure 4.4 - Page d'accueil d'UniPortal (bandeau affiché tant que le tenant n'est pas configuré)*

![Figure 4.5 - Fonctionnalités présentées sur la page d'accueil](images/fig-4-5-fonctionnalites.png)
*Figure 4.5 - Fonctionnalités et renvois au chapitre 3*

![Figure 4.6 - Illustration du flux Authorization Code + PKCE](images/fig-4-6-flux.png)
*Figure 4.6 - Les six étapes du flux, avec les requêtes HTTP correspondantes*

**Page de retour.** Minimale, elle affiche un indicateur de progression pendant l'échange du code. En cas d'échec, elle affiche le message d'Auth0 et une piste de diagnostic tirée de la méthode du §3.7.7 : `state` invalide, URL de retour non autorisée, accès refusé ou problème réseau.

**Tableau de bord.** Il est protégé par `requireAuth()`. Le contenu reste masqué tant que la session n'est pas confirmée, afin d'éviter tout affichage furtif. L'en-tête présente l'avatar, le nom, l'adresse et le rôle de l'utilisateur, ainsi que le bouton de déconnexion. La vue dépend ensuite du rôle.

![Figure 4.7 - Tableau de bord d'un étudiant](images/fig-4-7-etudiant.png)
*Figure 4.7 - Vue étudiant : relevé personnel servi par l'API*

![Figure 4.8 - Tableau de bord d'un enseignant](images/fig-4-8-enseignant.png)
*Figure 4.8 - Vue enseignant : étudiants du cours RES301 et saisie des notes*

La pastille « Données servies par l'API, jeton vérifié » rappelle l'origine des informations. Si le serveur Node n'est pas lancé, par exemple quand le site est servi par un simple `python -m http.server`, le tableau de bord bascule sur des données locales et l'indique.

> **À retenir :** masquer une vue ou un bouton dans le navigateur n'est qu'un confort d'interface. Un utilisateur peut toujours lire le code ou forger une requête. La décision d'accès appartient à l'API (§3.9).

### 4.5.4 L'inspecteur JWT

L'inspecteur est un panneau pédagogique inspiré de jwt.io. Il affiche, pour l'ID token comme pour l'access token :

- le jeton encodé, coloré par partie : en-tête en rouge, contenu en violet, signature en bleu ;
- l'en-tête décodé (algorithme, type, identifiant de clé `kid`) ;
- le contenu décodé, les horodatages `iat` et `exp` étant traduits en dates lisibles ;
- la formule de signature RS256 et la signature brute ;
- un tableau qui explique chaque claim ;
- un indicateur d'expiration, mis à jour chaque seconde.

![Figure 4.11 - Inspecteur JWT](images/fig-4-11-inspecteur.png)
*Figure 4.11 - Inspecteur JWT : l'ID token décodé*

Le décodage se fait localement, sans aucune vérification, par la fonction `decodeJWT()` :

```js
function base64UrlDecode(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
```

Ces quelques lignes suffisent à lire n'importe quel JWT. Cela démontre la mise en garde du §3.2.5 : un JWT est encodé, pas chiffré. Il ne doit contenir aucune donnée confidentielle, et sa lisibilité ne prouve rien.

L'onglet « Access token » montre que les deux jetons diffèrent par leur audience : l'ID token est destiné au *Client ID*, l'access token à l'API. Cette différence, invisible dans l'interface, est précisément celle que l'API vérifie (§3.6.1).

### 4.5.5 Interface et accessibilité

L'interface suit une charte sobre : fond dégradé lavande avec des sphères translucides réalisées en CSS pur, cartes blanches aux angles arrondis, couleur primaire indigo profond (`#1e1b4b`) et accent orangé (`#f59e0b`). La feuille de styles est écrite *mobile-first* : les styles de base ciblent le téléphone, et des requêtes média enrichissent la mise en page à partir de 640 et 900 pixels.

Quelques mesures d'accessibilité ont été appliquées : contrastes suffisants, focus clavier visible, libellés pour les lecteurs d'écran, zones `aria-live` pour les messages, animations désactivées si l'utilisateur le demande (`prefers-reduced-motion`). Toutes les données insérées dans la page sont échappées, ce qui limite le risque d'injection de script.

![Figure 4.12 - Affichage mobile](images/fig-4-12-mobile.png)
*Figure 4.12 - Tableau de bord sur un écran de 390 pixels*

## 4.6 L'API de validation

### 4.6.1 Rôle

Le §3.1.4 rappelle qu'Auth0 ne remplace pas le backend et ne connaît pas les règles métier. L'API UniPortal tient ce rôle. Elle est écrite en Node.js, sans dépendance, à l'aide des modules natifs `node:http` et `node:crypto`. Ce choix est délibéré : chaque contrôle listé au §3.6.2 apparaît en clair dans `server/jwt.js`, au lieu d'être caché dans une bibliothèque.

### 4.6.2 La chaîne de contrôles

Chaque requête vers une route protégée traverse la chaîne de la figure 4.3. Le premier contrôle qui échoue l'interrompt.

![Figure 4.3 - Chaîne de contrôles de l'API](images/fig-4-3-validation.png)
*Figure 4.3 - Chaîne de contrôles appliquée par l'API à chaque requête*

*Tableau 4.7 - Contrôles appliqués par l'API*

| N° | Contrôle | Règle | En cas d'échec |
| --- | --- | --- | --- |
| 1 | En-tête | `Authorization: Bearer <jeton>` présent et bien formé | 401 `invalid_request` |
| 2 | Format | Trois segments Base64URL contenant du JSON | 401 `invalid_token` |
| 3 | Algorithme | `alg` vaut exactement `RS256` ; `none` et `HS256` sont refusés | 401 `invalid_token` |
| 4 | Signature | Vérifiée avec la clé publique désignée par `kid` dans le JWKS | 401 `invalid_token` |
| 5 | Émetteur | `iss` vaut `https://<tenant>/` | 401 `invalid_token` |
| 6 | Audience | `aud` contient l'identifiant de l'API | 401 `invalid_token` |
| 7 | Expiration | `exp` non dépassé, `nbf` atteint, tolérance de 60 s | 401 `invalid_token` |
| 8 | Rôle | La claim des rôles contient le rôle requis | 403 `insufficient_role` |
| 9 | Propriété / affectation | La fiche appartient au demandeur, ou l'enseignant est affecté au cours | 403 `forbidden` |

Le contrôle de l'algorithme mérite une attention particulière. Si un serveur se fiait au champ `alg` fourni par le jeton lui-même, un attaquant pourrait annoncer `none` (aucune signature) ou `HS256`. Dans ce second cas, la clé publique RSA, qui n'a rien de secret, servirait de clé HMAC. UniPortal n'accepte donc que l'algorithme configuré sur l'API.

### 4.6.3 Vérification de la signature

```js
// 3. Signature : vérifiée avec la clé publique du tenant (§3.6.2).
const key = await getKey(header.kid);
if (!key) fail('Signature', `Clé "${header.kid}" absente du JWKS du tenant`);

const signedData = Buffer.from(`${parts[0]}.${parts[1]}`);
const signature = base64UrlToBuffer(parts[2]);
if (!verify('RSA-SHA256', signedData, key, signature)) {
  fail('Signature', 'Signature invalide : le jeton a été modifié ou n\'a pas été signé par ce tenant.');
}
```

La donnée signée est la concaténation exacte des deux premiers segments encodés. La moindre modification de l'en-tête ou du contenu, par exemple l'ajout d'un rôle, rend la signature invalide.

### 4.6.4 Gestion des clés publiques

Les clés sont téléchargées depuis `https://<tenant>/.well-known/jwks.json`, converties au format natif de Node.js (`createPublicKey({ key, format: 'jwk' })`) et conservées en cache dix minutes. Lorsqu'un jeton désigne une clé inconnue, ce qui peut signaler une rotation de clé côté Auth0, le JWKS est téléchargé à nouveau, au plus une fois toutes les trente secondes. Cette limite empêche un attaquant de faire marteler le tenant avec des identifiants inventés.

Si le tenant ne répond pas alors que la clé demandée est déjà connue, l'API conserve la copie en cache et continue de valider les jetons. Ce téléchargement est un **flux sortant** de l'API vers Internet. C'est la ligne « API vers métadonnées/clés » du tableau du §3.7.3. S'il est bloqué par un pare-feu ou un proxy dès le démarrage, aucune clé n'est connue et aucune requête ne peut être validée : l'API répond alors 502, pour signaler un problème d'infrastructure plutôt qu'une faute du client.

### 4.6.5 Autorisation et routes

*Tableau 4.8 - Routes de l'API*

| Méthode et route | Accès | Notion illustrée |
| --- | --- | --- |
| `GET /api/sante` | Public | Détection de l'API par le frontend |
| `GET /api/notes/me` | Rôle `etudiant` | Fiche retrouvée par la claim `sub` |
| `GET /api/etudiants/:id/notes` | Propriétaire, ou rôle `enseignant` | Modification d'URL refusée (§3.9) |
| `GET /api/cours/:code/etudiants` | `enseignant` affecté au cours | Autorisation fine (§3.5.3) |
| `PUT /api/cours/:code/notes/:id` | `enseignant` affecté au cours | Saisie revalidée côté serveur |

Trois niveaux d'autorisation se superposent :

- **le rôle** (RBAC, §3.5.3) : un utilisateur sans rôle n'a aucun droit, selon le principe du moindre privilège ;
- **la propriété** : un étudiant ne peut lire que sa propre fiche, rattachée à sa claim `sub`. Changer le numéro dans l'URL aboutit à un refus 403, même avec un jeton parfaitement valide ;
- **l'affectation** : un enseignant n'accède qu'aux cours qui lui sont attribués. Dans la démonstration, tout enseignant assure `RES301`, et une demande sur `SEC302` est refusée.

Enfin, la note saisie est revalidée par le serveur (nombre compris entre 0 et 20), car un formulaire de navigateur se contourne aisément.

### 4.6.6 Codes de réponse

*Tableau 4.9 - Codes de réponse de l'API*

| Code | Signification | Exemple |
| --- | --- | --- |
| 200 | Jeton valide et action autorisée | Relevé de notes |
| 400 | Requête mal formée | Note égale à 25 |
| 401 | Jeton absent, falsifié, expiré, mauvais émetteur ou mauvaise audience | ID token envoyé à la place de l'access token |
| 403 | Identité valide, action interdite | Étudiant demandant la fiche d'un autre |
| 404 | Ressource inexistante | Cours inconnu |
| 502 | Clés publiques du tenant injoignables | Pare-feu bloquant le HTTPS sortant |

Chaque réponse 401 comporte l'en-tête défini par la RFC 6750, qui indique au client le schéma attendu et la raison du refus :

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="uniportal", error="invalid_token",
  error_description="Signature invalide : le jeton a ete modifie ..."
```

À des fins pédagogiques, chaque réponse inclut aussi un tableau `checks` qui retrace les contrôles effectués et leur résultat. Une API de production n'exposerait pas ce niveau de détail, qui renseignerait un attaquant.

### 4.6.7 Journalisation

Le serveur consigne chaque requête : date, méthode, route, statut et durée de traitement.

```
[api] 2026-10-20T05:47:39.448Z PUT /api/cours/RES301/notes/E2026-9F91 -> 200 (3 ms)
[api] 2026-10-20T05:47:39.566Z GET /api/notes/me -> 401 (0 ms)
```

Conformément au §3.5.5, aucun jeton, mot de passe ou secret n'est écrit dans les journaux. Les horodatages au format ISO 8601 permettent de corréler ces lignes avec les journaux du tenant Auth0 (*Monitoring > Logs*), ce qui suppose des horloges synchronisées (§3.7.6).

### 4.6.8 La console API

La console du tableau de bord envoie de vraies requêtes à l'API et affiche, pour chacune, la requête envoyée, le statut obtenu, l'en-tête `WWW-Authenticate` éventuel, la liste des contrôles et le corps de la réponse. Six scénarios sont proposés, adaptés au rôle de l'utilisateur.

*Tableau 4.10 - Scénarios de la console API*

| Scénario | Ce qui est envoyé | Résultat | Contrôle en cause |
| --- | --- | --- | --- |
| Requête légitime | Access token valide | 200 | Tous réussis |
| Sans jeton | Aucun en-tête `Authorization` | 401 | En-tête |
| Jeton falsifié | Rôles remplacés par `enseignant` et `admin`, signature d'origine conservée | 401 | Signature |
| Mauvais jeton | ID token à la place de l'access token | 401 | Audience |
| Ressource d'autrui | Fiche d'un autre étudiant (ou cours non affecté pour un enseignant) | 403 | Propriété / affectation |
| Rôle manquant | Saisie de note par un étudiant (ou route étudiante pour un enseignant) | 403 | Rôle |

Le scénario du jeton falsifié est le plus parlant. Le frontend décode l'access token, remplace la liste des rôles, réencode le contenu et conserve la signature d'origine. Le jeton obtenu est parfaitement lisible et semble accorder des droits d'enseignant. L'API le rejette pourtant dès la vérification de signature.

![Figure 4.9 - Console API : jeton falsifié](images/fig-4-9-console-falsifie.png)
*Figure 4.9 - Console API : un jeton aux rôles modifiés est rejeté à la vérification de signature*

![Figure 4.10 - Console API : accès à la fiche d'un autre étudiant](images/fig-4-10-console-403.png)
*Figure 4.10 - Console API : jeton valide, mais fiche d'un autre étudiant, d'où un refus 403*

## 4.7 Analyse sous l'angle réseau

### 4.7.1 Flux réseau

*Tableau 4.11 - Flux réseau d'UniPortal*

| Flux | Protocole | Port | Points de contrôle |
| --- | --- | --- | --- |
| Navigateur vers CDN Auth0 (SDK) | HTTPS | TCP/443 | DNS, filtrage web, intégrité du script |
| Navigateur vers tenant Auth0 | HTTPS | TCP/443 | DNS, certificat, proxy, cookies |
| Tenant vers Google (connexion sociale) | HTTPS | TCP/443 | Paramètres de confiance, URL de retour |
| Navigateur vers serveur UniPortal | HTTP en local, HTTPS en production | 8080 en local, 443 en production | Routage, pare-feu, même origine |
| Serveur UniPortal vers tenant (JWKS) | HTTPS sortant | TCP/443 | Pare-feu sortant, proxy, certificat |

Il faut noter que le serveur UniPortal ne reçoit jamais de connexion de la part d'Auth0. Toutes les interactions avec le tenant passent par le navigateur, sauf le téléchargement des clés, initié par l'API. En termes de filtrage, l'API n'a besoin que d'un flux sortant HTTPS vers le domaine du tenant.

### 4.7.2 DNS, TLS et endpoints

Le domaine du tenant doit être résolu par le navigateur et par le serveur (§3.7.1). Avec un domaine personnalisé, par exemple `login.universite.fr`, il faudrait des enregistrements DNS cohérents et un certificat adapté. Tous les échanges avec Auth0 sont chiffrés par TLS (§3.7.2). La validation du certificat permet au navigateur et à l'API de s'assurer qu'ils parlent bien au tenant, et non à un intermédiaire.

Les endpoints du §3.7.4 apparaissent tous dans la démonstration : `/authorize` à l'étape 2, `/oauth/token` aux étapes 4 et lors des renouvellements, `/v2/logout` à la déconnexion, et `/.well-known/jwks.json` côté API. `/userinfo` n'est pas utilisé, car le profil est lu dans l'ID token déjà validé.

### 4.7.3 Observer les échanges

Les outils de développement du navigateur (onglet *Réseau*, avec l'option « Conserver le journal ») permettent d'observer l'ensemble du flux :

1. la requête `GET /authorize` et ses paramètres `code_challenge`, `state`, `nonce` ;
2. la réponse `302` vers `callback.html?code=...&state=...` ;
3. la requête `POST /oauth/token` contenant le `code_verifier`, et sa réponse JSON portant les jetons ;
4. les appels `/api/...` et leur en-tête `Authorization: Bearer`.

Côté serveur, le terminal affiche en parallèle la journalisation des requêtes reçues.

### 4.7.4 Impact d'une panne ou d'un filtrage

*Tableau 4.12 - Conséquences d'une défaillance réseau*

| Défaillance | Symptôme dans UniPortal | Diagnostic (§3.7.7) |
| --- | --- | --- |
| Tenant non résolu (DNS) | La page de connexion ne s'ouvre pas | `nslookup <tenant>` |
| CDN Auth0 bloqué | Message « SDK Auth0 non chargé » | Filtrage web, proxy |
| URL de retour non déclarée | Erreur Auth0 après connexion | Comparer l'URL exacte à la configuration |
| HTTPS sortant bloqué côté serveur | L'API répond 502 | Pare-feu sortant, proxy |
| Horloge du serveur décalée | 401 « expiré » sur des jetons récents | Synchronisation NTP |
| Tenant indisponible | Nouvelles connexions impossibles ; les jetons déjà émis restent valides jusqu'à expiration | Page de statut du fournisseur |

Le dernier cas illustre la dépendance au fournisseur évoquée au §3.8.3. Si le tenant devient injoignable, l'API continue de valider les jetons déjà émis avec les clés gardées en cache. En revanche, aucun nouvel utilisateur ne peut se connecter, et les sessions s'interrompent à l'expiration des jetons, faute de pouvoir les renouveler.

## 4.8 Sécurité

### 4.8.1 Menaces et contre-mesures

*Tableau 4.13 - Menaces et contre-mesures mises en œuvre*

| Menace | Contre-mesure | Implémentation | Référence |
| --- | --- | --- | --- |
| Vol du code d'autorisation | PKCE (S256) | SDK, par défaut | §3.4 étape 4 |
| CSRF sur le retour | Paramètre `state` | SDK | §3.4 étape 2 |
| Rejeu d'ID token | `nonce` | SDK | §3.6.2 |
| Détournement du retour | Liste blanche stricte des URL | Configuration Auth0 | §3.6.3 |
| Jeton fabriqué ou modifié | Signature RS256 vérifiée | `server/jwt.js` | §3.6.2 |
| Confusion d'algorithme | Seul RS256 accepté | `server/jwt.js` | §3.6.2 |
| Jeton détourné vers une autre API | Contrôle de `aud` | `server/jwt.js` | §3.6.1 |
| Jeton expiré | Contrôle de `exp` et `nbf` | `server/jwt.js` | §3.6.2 |
| Accès aux données d'autrui | Propriété et affectation | `server/server.js` | §3.9 |
| Élévation de privilège | RBAC, moindre privilège | Action + API | §3.5.3 |
| Vol de refresh token | Rotation des refresh tokens | Configuration Auth0 | §3.6.1 |
| Secret exposé dans le navigateur | Client public sans secret | Type SPA | §3.6.3 |
| Injection de script | Échappement des données affichées | `js/app.js` | §3.6.3 |
| Fuite de jetons dans les journaux | Journal sans jeton | `server/server.js` | §3.5.5 |
| Lecture des fichiers du serveur | Liste blanche des fichiers servis | `server/server.js` | - |

### 4.8.2 Le stockage des jetons

Le choix de `cacheLocation: 'localstorage'` est un compromis assumé. La session survit au rechargement et à l'ouverture d'un nouvel onglet, ce qui rend la démonstration fluide. En contrepartie, un script malveillant injecté dans la page pourrait lire les jetons. L'option par défaut du SDK (`memory`) est plus sûre, mais impose un renouvellement à chaque rechargement. Dans une application de production, on combinerait une politique de sécurité du contenu (CSP) stricte, des jetons de courte durée et la rotation des refresh tokens. On pourrait aussi adopter une architecture où les jetons restent côté serveur (motif *Backend for Frontend*).

### 4.8.3 Limites assumées

Plusieurs simplifications propres à la démonstration doivent être signalées :

- le serveur écoute en HTTP sur `localhost` ; en production, il serait placé derrière HTTPS (§3.7.2) ;
- le tableau `checks` renvoyé par l'API documente les refus en détail, ce qu'une API réelle éviterait ;
- l'affectation des enseignants est simplifiée : tout enseignant assure `RES301` ;
- la validation des jetons est écrite à la main pour la lisibilité ; en production, on s'appuierait sur une bibliothèque éprouvée, comme `jose` ou `express-oauth2-jwt-bearer`, qui applique les mêmes contrôles.

## 4.9 Tests et validation

### 4.9.1 Méthode

Le projet a été vérifié sans tenant Auth0 réel, de manière à tester l'API de bout en bout et de façon reproductible :

- une **paire de clés RSA** de 2048 bits a été générée localement, et un JWKS équivalent à celui d'un tenant a été publié à partir de la clé publique ;
- le téléchargement du JWKS par l'API a été redirigé vers ce fichier ; le reste du code s'exécute sans modification ;
- des **jetons signés RS256** ont été produits avec la clé privée, puis altérés selon chaque scénario ;
- les requêtes ont été envoyées avec `curl`, puis depuis le tableau de bord dans un navigateur Chromium piloté par Playwright, avec un SDK simulé fournissant ces jetons.

Ces tests valident l'API et le frontend. Ils ne remplacent pas un essai avec un tenant réel, qui reste nécessaire pour vérifier la configuration Auth0 (URL autorisées, Action, rôles).

### 4.9.2 Résultats côté API

*Tableau 4.14 - Résultats des tests de l'API (19 cas)*

| Cas testé | Attendu | Obtenu |
| --- | --- | --- |
| Route publique `/api/sante` | 200 | 200 |
| Étudiant, `/api/notes/me` | 200 | 200 |
| Sans en-tête `Authorization` | 401 | 401 |
| Schéma `Basic` au lieu de `Bearer` | 401 | 401 |
| Contenu modifié, signature d'origine | 401 | 401 (signature) |
| Audience égale au *Client ID* (ID token) | 401 | 401 (audience) |
| Jeton expiré | 401 | 401 (expiration) |
| Émetteur étranger | 401 | 401 (émetteur) |
| Algorithme `HS256` annoncé | 401 | 401 (algorithme) |
| Clé `kid` inconnue | 401 | 401 (signature) |
| Jeton valide sans rôle | 403 | 403 |
| Étudiant, fiche d'un autre étudiant | 403 | 403 |
| Étudiant, liste d'un cours | 403 | 403 |
| Étudiant, saisie de note | 403 | 403 |
| Enseignant, cours affecté | 200 | 200 |
| Enseignant, cours non affecté | 403 | 403 |
| Enseignant, saisie d'une note valide | 200 | 200 |
| Enseignant, note égale à 25 | 400 | 400 |
| Note saisie visible par l'étudiant concerné | 14,5 | 14,5 |

Les tests ont aussi vérifié que les fichiers du dossier `server/` et `package.json` ne sont pas servis, y compris par une tentative de remontée de répertoire (`/css/../server/data.js`), et qu'une URL mal encodée ne provoque pas d'arrêt du serveur.

### 4.9.3 Résultats côté interface

Les six scénarios de la console ont été rejoués pour chacun des deux rôles, soit douze requêtes. Toutes ont produit le code attendu. La saisie d'une note par un enseignant a été suivie de l'affichage de la confirmation, puis de la mise à jour de la liste. L'affichage a été contrôlé à 1280 et à 390 pixels de large, sans défilement horizontal de la page. Enfin, le tableau de bord sans configuration renvoie bien vers l'accueil, et l'accueil affiche alors le bandeau d'aide.

## 4.10 Guide de démonstration pour l'oral

La démonstration dure une dizaine de minutes. Elle suppose un tenant configuré, deux comptes (un étudiant, un enseignant) et le serveur lancé avec `npm start`.

*Tableau 4.15 - Déroulé conseillé de la démonstration*

| N° | Action | Ce que l'on montre | Phrase clé |
| --- | --- | --- | --- |
| 1 | Ouvrir l'accueil et l'onglet *Réseau* | Le site ne contient aucun formulaire de mot de passe | « L'application ne verra jamais le mot de passe. » |
| 2 | Cliquer sur « Se connecter » | `GET /authorize`, `code_challenge`, `state` | « Seule l'empreinte du secret PKCE quitte le navigateur. » |
| 3 | Se connecter en étudiant | Universal Login, retour `302` avec `code` | « Le code seul ne sert à rien sans le verifier. » |
| 4 | Montrer `POST /oauth/token` | Les trois jetons | « Trois jetons, trois rôles : ils ne sont pas interchangeables. » |
| 5 | Ouvrir l'inspecteur JWT | Contenu lisible, audiences différentes | « Lisible ne veut pas dire fiable. » |
| 6 | Console : jeton falsifié | 401, contrôle de signature en échec | « Modifier un rôle casse la signature. » |
| 7 | Console : ID token envoyé | 401, audience | « L'ID token n'est pas fait pour appeler une API. » |
| 8 | Console : fiche d'un autre | 403, propriété | « Jeton valide ne veut pas dire accès autorisé. » |
| 9 | Second navigateur en enseignant, saisir une note | La note apparaît chez l'étudiant | « La donnée vit côté serveur, protégée par l'API. » |
| 10 | Montrer les journaux du tenant et du terminal | Corrélation des événements, sans jeton | « On journalise les événements, jamais les secrets. » |

En cas d'absence de réseau le jour de l'exposé, l'accueil reste consultable. Le flux y est illustré avec les requêtes réelles, et le tableau de bord peut fonctionner en mode local grâce aux données de repli.

## 4.11 Limites et perspectives

**Limites.** Les données sont conservées en mémoire et perdues à l'arrêt du serveur. Il n'existe que deux rôles, sans administrateur, et l'affectation aux cours est simplifiée. Le serveur fonctionne en HTTP local. Enfin, les essais ont été menés avec des jetons signés localement : la configuration du tenant reste à valider en conditions réelles.

**Perspectives.**

- persister les données dans une base, avec une table d'affectation enseignant-cours ;
- ajouter un rôle administrateur protégé par une MFA obligatoire (§3.5.2) ;
- remplacer la validation manuelle par une bibliothèque éprouvée et ajouter des tests automatisés ;
- utiliser les *permissions* RBAC d'Auth0 (claim `permissions`, par exemple `read:notes` et `write:notes`) à la place des seuls rôles ;
- déployer derrière un reverse proxy HTTPS, avec un domaine personnalisé pour le tenant (§3.7.1, §3.7.5) ;
- exporter les journaux du tenant vers un SIEM et les corréler avec ceux de l'API (§3.5.5, §3.7.6) ;
- appliquer une politique de sécurité du contenu (CSP) et réduire la durée de vie des jetons.

## 4.12 Conclusion

UniPortal montre qu'une intégration d'Auth0 fidèle aux standards tient en peu de code, à condition d'en comprendre chaque élément. Le frontend délègue l'authentification à Universal Login et laisse le SDK appliquer PKCE, `state` et `nonce`. Le tenant porte l'identité, les connexions et les rôles. L'API, enfin, applique la règle centrale du chapitre 3 : elle ne fait confiance qu'à un jeton dont elle a vérifié la signature, l'émetteur, l'audience et l'expiration, puis elle décide seule de l'accès aux données.

Pour l'administration réseau, la démonstration rend tangibles des notions souvent abstraites : les flux HTTPS sur TCP/443, le rôle du DNS et de TLS, le flux sortant vers le JWKS, et la lecture d'un 401 ou d'un 403 lors d'un diagnostic. Elle illustre enfin la responsabilité partagée du §3.8.3 : Auth0 fournit des mécanismes solides, mais la sécurité de l'ensemble dépend de la configuration, du code de l'API et de l'infrastructure réseau.

## Annexe A - Installation et lancement

**Prérequis.** Node.js 18 ou plus, un navigateur récent et un compte Auth0 gratuit.

**Configuration.**

1. Créer le tenant, l'application SPA, l'API, les connexions, les rôles et l'Action, comme décrit au §4.3 et dans le `README.md`.
2. Renseigner le domaine et le *Client ID* dans `uniportal/js/auth.js` :

```js
const AUTH0_CONFIG = {
  domain: 'uniportal-demo.eu.auth0.com',
  clientId: '<CLIENT_ID>',
  audience: 'https://api.uniportal.example.com',
};
```

**Lancement avec l'API (recommandé).**

```
cd uniportal
npm start
```

Le serveur écoute sur `http://localhost:8080`. Il lit le domaine et l'audience dans `js/auth.js`. Les variables d'environnement `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` et `PORT` permettent de les surcharger.

**Lancement du frontend seul.** `python -m http.server 8080` dans le dossier `uniportal`. Le tableau de bord fonctionne alors en mode local, sans console API.

Il faut utiliser `localhost` et non `127.0.0.1` : Auth0 considère ces deux origines comme différentes.

**Mise en ligne.** Le fichier `render.yaml` permet de publier l'application sur Render, qui exécute `npm start` sans modification et fournit le HTTPS. L'adresse publique obtenue, par exemple `https://uniportal.onrender.com`, doit être ajoutée aux URL autorisées de l'application Auth0 (§4.3.1). L'offre gratuite met le service en veille après une période d'inactivité et réinitialise alors les données en mémoire. La procédure détaillée figure dans le `README.md`.

## Annexe B - Référence de l'API

**Requête type.**

```
GET /api/notes/me HTTP/1.1
Host: localhost:8080
Authorization: Bearer <access_token>
Accept: application/json
```

**Réponse 200 (extrait).**

```json
{
  "etudiant": { "id": "E2026-254C", "nom": "Awa Traoré", "groupe": "TD1" },
  "moyenne": 12.72,
  "notes": [
    { "code": "SEC302", "matiere": "Sécurité des systèmes", "coef": 3, "note": 13.25 }
  ],
  "checks": [
    { "name": "Signature", "ok": true, "detail": "Vérifiée avec la clé publique ..." }
  ]
}
```

**Saisie d'une note.**

```
PUT /api/cours/RES301/notes/E2024-027 HTTP/1.1
Authorization: Bearer <access_token enseignant>
Content-Type: application/json

{ "note": 14.5 }
```

**Réponse d'erreur.**

```json
{
  "error": "forbidden",
  "message": "Cette fiche appartient à un autre étudiant : le jeton est valide, mais l'accès est refusé.",
  "checks": [ "..." ]
}
```

## Annexe C - Dépannage

*Tableau 4.16 - Symptômes courants et actions*

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| Bandeau « Auth0 n'est pas encore configuré » | Valeurs d'exemple dans `js/auth.js` | Renseigner le domaine et le *Client ID* |
| `Callback URL mismatch` | URL de retour non déclarée | Comparer l'URL exacte à la configuration |
| Page Auth0 inaccessible | DNS, proxy, pare-feu, certificat | Tester la résolution et l'accès HTTPS |
| `Invalid state` au retour | Page rechargée, transaction expirée | Relancer la connexion depuis l'accueil |
| Rôle toujours « Étudiant » | Rôle non assigné ou Action non attachée | Vérifier les rôles et le déclencheur post-login, se reconnecter |
| « Mode local : API non démarrée » | Site servi sans le serveur Node | Lancer `npm start` |
| 403 sur toutes les routes | Aucun rôle dans l'access token | L'Action doit écrire dans `api.accessToken` |
| 401 « audience » sur une requête légitime | Audience différente entre Auth0 et le code | Aligner l'identifiant de l'API, se reconnecter |
| Access token « opaque » dans l'inspecteur | Audience absente | Déclarer l'API et renseigner `audience` |
| 502 côté API | JWKS injoignable depuis le serveur | Vérifier DNS et HTTPS sortant |

## Annexe D - Glossaire complémentaire

*Tableau 4.17 - Termes propres à la mise en œuvre*

| Terme | Définition |
| --- | --- |
| Access token | Jeton présenté à l'API pour accéder à une ressource ; son audience est l'API |
| Audience (`aud`) | Destinataire prévu d'un jeton |
| Base64URL | Variante de Base64 utilisable dans une URL, employée par les JWT |
| Claim | Information contenue dans un jeton (`sub`, `exp`, rôles, etc.) |
| Client public | Application incapable de garder un secret, comme une SPA ou une application mobile |
| `code_verifier` | Secret aléatoire de PKCE, conservé par le client |
| ID token | Jeton décrivant le résultat de l'authentification pour le client |
| JWKS | Jeu de clés publiques publié par le tenant pour vérifier les signatures |
| `kid` | Identifiant de la clé ayant signé un jeton |
| Namespace | URL préfixant une claim personnalisée |
| `nonce` | Valeur aléatoire liant l'ID token à la requête d'origine |
| PKCE | *Proof Key for Code Exchange*, protection du code d'autorisation |
| Refresh token | Jeton permettant d'obtenir de nouveaux jetons sans nouvelle connexion |
| RS256 | Signature RSA avec SHA-256, asymétrique |
| SPA | *Single Page Application*, application web exécutée dans le navigateur |
| `state` | Valeur aléatoire liant la réponse d'Auth0 à la requête de l'application |
