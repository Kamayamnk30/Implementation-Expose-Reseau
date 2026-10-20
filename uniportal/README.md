# UniPortal

Plateforme universitaire de consultation de notes, construite pour illustrer le **chapitre 3 de l'exposé d'administration réseau : présentation générale d'Auth0**.

Le frontend est en HTML, CSS et JavaScript vanilla. L'authentification repose sur Auth0 avec le flux **Authorization Code + PKCE** (OAuth 2.0 / OpenID Connect), des **JWT** signés et un contrôle d'accès par **rôles (RBAC)**.

Un backend Node.js léger, sans aucune dépendance, joue le rôle de l'API métier : il valide chaque access token (signature, émetteur, audience, expiration) puis applique les droits. Il rend l'étape 6 du §3.4 démontrable en direct.

```
uniportal/
├── index.html        Page d'accueil publique (fonctionnalités, flux, sécurité)
├── callback.html     Retour du flux Auth0 : échange du code contre les jetons
├── dashboard.html    Espace protégé : vue étudiant / enseignant + inspecteur JWT
├── css/style.css     Styles globaux (mobile-first)
├── js/auth.js        Module Auth0 (SDK, login, logout, jetons, rôles)
├── js/app.js         Logique applicative des trois pages, console API
├── server/
│   ├── server.js     Serveur HTTP : fichiers du frontend + routes /api
│   ├── jwt.js        Validation des access tokens (JWKS, RS256, iss, aud, exp)
│   └── data.js       Données de démonstration en mémoire
├── package.json      Script npm start (aucune dépendance à installer)
└── README.md         Ce guide
```

## Correspondance avec le chapitre 3

| Élément du projet | Section |
| --- | --- |
| Tenant, domaine, application SPA | §3.3.1, §3.3.2 |
| Redirection vers Universal Login | §3.3.3 |
| Connexion Google | §3.3.4 |
| Action post-login (rôles dans le jeton) | §3.3.5 |
| Les 6 étapes de la page d'accueil | §3.4 |
| MFA, RBAC, journaux | §3.5.2, §3.5.3, §3.5.5 |
| ID token / access token, inspecteur JWT | §3.6.1, §3.6.2 |
| Endpoints /authorize, /oauth/token, /v2/logout | §3.7.4 |
| Messages d'erreur du callback | §3.7.7, §3.9 |
| Vues étudiant / enseignant | §3.9 |
| Validation du jeton par l'API (server/jwt.js) | §3.4 étape 6, §3.6.2 |
| Codes 401 / 403 de la console API | §3.9, tableau de dépannage |
| Téléchargement des clés publiques (JWKS) | §3.7.3, flux API vers métadonnées |

---

## Configuration d'Auth0

### 1. Créer un compte Auth0 gratuit

Rendez-vous sur [auth0.com](https://auth0.com) et cliquez sur **Sign up**. L'offre gratuite suffit pour la démonstration.

### 2. Créer un tenant

À la première connexion, Auth0 propose de créer un tenant (§3.3.1) :

- **Tenant domain** : par exemple `uniportal-demo` ; le domaine sera `uniportal-demo.eu.auth0.com` (la région apparaît dans le nom).
- **Region** : choisissez la plus proche de votre auditoire.

Pour en créer un autre plus tard : menu du tenant en haut à gauche, puis **Create tenant**.

### 3. Créer une application SPA

1. **Applications > Applications > Create Application**.
2. Nom : `UniPortal`, type : **Single Page Web Applications**, puis **Create**.
3. Onglet **Settings**, notez :
   - **Domain**, par exemple `uniportal-demo.eu.auth0.com`
   - **Client ID**
4. Reportez-les dans `js/auth.js` :

```js
const AUTH0_CONFIG = {
  domain: 'uniportal-demo.eu.auth0.com',
  clientId: 'votre_client_id',
  audience: 'https://api.uniportal.example.com',
};
```

Une SPA est un client public : il n'y a **pas** de Client Secret à copier dans le code (§3.6.3).

### 4. Configurer les URL autorisées

Toujours dans **Settings > Application URIs**, en adaptant le port à votre serveur local (voir étape 10) :

| Champ | Valeur |
| --- | --- |
| Allowed Callback URLs | `http://localhost:8080/callback.html` |
| Allowed Logout URLs | `http://localhost:8080/index.html` |
| Allowed Web Origins | `http://localhost:8080` |
| Allowed Origins (CORS) | `http://localhost:8080` |

Si le projet est servi depuis un sous-dossier (par exemple `http://localhost:8080/uniportal/`), ajoutez ce chemin dans chaque URL. Auth0 compare les URL à l'identique : une seule différence de port, de chemin ou de `/` final provoque une erreur `Callback URL mismatch` (§3.4, étape 2).

Dans **Advanced Settings > Grant Types**, vérifiez que **Authorization Code** et **Refresh Token** sont cochés. Dans la section **Refresh Token Rotation**, activez **Rotation** (§3.6.1), puis cliquez sur **Save Changes**.

### 5. Activer les connexions

1. **Authentication > Database** : la connexion `Username-Password-Authentication` existe par défaut. Ouvrez-la et, dans l'onglet **Applications**, activez-la pour UniPortal.
2. **Authentication > Social > Create Connection > Google** : laissez les clés de développement Auth0 pour la démo (à remplacer par vos propres identifiants Google en production), puis activez-la pour UniPortal.
3. Facultatif, MFA (§3.5.2) : **Security > Multi-factor Auth**, activez **One-time Password**, puis réglez la politique sur **Always** ou **Adaptive**.

### 6. Créer une API (audience)

L'API représente le backend qui servirait les notes. Elle permet d'obtenir un access token au format JWT, avec une audience vérifiable (§3.6.2).

1. **Applications > APIs > Create API**.
2. Name : `UniPortal API`
3. Identifier : `https://api.uniportal.example.com` (il doit correspondre à `audience` dans `js/auth.js`. Cette URL n'a pas besoin d'exister : c'est seulement un identifiant).
4. Signing Algorithm : **RS256**.
5. Dans **Settings**, activez **Allow Offline Access** pour autoriser les refresh tokens.
6. Facultatif : dans **RBAC Settings**, activez **Enable RBAC** et **Add Permissions in the Access Token**.

### 7. Créer les rôles

1. **User Management > Roles > Create Role**.
2. Créez `etudiant` (description : « Consulte ses propres notes »).
3. Créez `enseignant` (description : « Saisit les notes de ses cours »).
4. **User Management > Users** : ouvrez un utilisateur (créez-en un si nécessaire), onglet **Roles > Assign Roles**.

Les noms doivent être écrits exactement `etudiant` et `enseignant`, sans accent, car `getUserRole()` les compare tels quels. Un utilisateur sans rôle est traité comme étudiant (moindre privilège, §3.5.3).

### 8. Créer une Action post-login

Par défaut, Auth0 n'ajoute pas les rôles dans les jetons. Une Action (§3.3.5) s'en charge à chaque connexion :

1. **Actions > Library > Create Action > Build from scratch**.
2. Name : `Ajouter les roles`, Trigger : **Login / Post Login**, Runtime : la version Node.js recommandée.
3. Collez le code de l'étape 9, puis **Deploy**.
4. **Actions > Triggers > post-login** : glissez l'Action `Ajouter les roles` entre **Start** et **Complete**, puis **Apply**.

### 9. Code de l'Action

```js
/**
 * Action post-login : injecte les roles RBAC dans l'ID token et l'access token.
 * Le namespace (une URL) evite les collisions avec les claims standard OIDC.
 * Il doit correspondre a ROLES_NAMESPACE dans js/auth.js.
 *
 * @param {Event} event - Details sur l'utilisateur et le contexte de connexion.
 * @param {PostLoginAPI} api - Interface pour modifier le comportement de la connexion.
 */
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://uniportal.example.com/roles';
  const roles = (event.authorization && event.authorization.roles) || [];

  // ID token : lu par la SPA pour adapter l'interface
  api.idToken.setCustomClaim(namespace, roles);

  // Access token : lu par l'API metier pour autoriser ou refuser (§3.4, etape 6)
  api.accessToken.setCustomClaim(namespace, roles);

  // Facultatif : nom affiche par l'API dans la liste des etudiants de l'enseignant
  api.accessToken.setCustomClaim('https://uniportal.example.com/name', event.user.name);
};
```

Une Action s'exécute au milieu du flux de connexion : un code lent ou qui appelle un service indisponible ralentit ou bloque toutes les connexions (§3.3.5).

### 10. Lancer le projet

Les modules ES et Auth0 imposent de servir les fichiers en HTTP : ouvrir `index.html` directement depuis le disque (`file://`) ne fonctionne pas.

**Recommandé : frontend + API** (Node.js 18 ou plus, rien à installer) :

```bash
cd uniportal
npm start
```

Le serveur écoute sur `http://localhost:8080`, sert les pages et expose `/api`. Il lit le domaine du tenant et l'audience directement dans `js/auth.js` : la configuration se fait à un seul endroit. Pour les surcharger :

```bash
AUTH0_DOMAIN=uniportal-demo.eu.auth0.com AUTH0_AUDIENCE=https://api.uniportal.example.com PORT=8080 npm start
```

**Frontend seul**, sans API : le tableau de bord bascule alors sur des données locales et la console API est désactivée.

Avec Python :

```bash
cd uniportal
python -m http.server 8080
```

Avec live-server (rechargement automatique) :

```bash
npm install -g live-server
cd uniportal
live-server --port=8080
```

Ouvrez ensuite `http://localhost:8080`. Utilisez `localhost` et non `127.0.0.1` : Auth0 traite ces deux origines comme différentes.

---

## L'API de validation

### Routes

| Méthode et route | Accès | Démontre |
| --- | --- | --- |
| `GET /api/sante` | Public | Détection de l'API par le frontend |
| `GET /api/notes/me` | Rôle `etudiant` | Fiche retrouvée par la claim `sub` |
| `GET /api/etudiants/:id/notes` | Propriétaire ou `enseignant` | Modification d'URL refusée (§3.9) |
| `GET /api/cours/:code/etudiants` | `enseignant` affecté au cours | Autorisation fine (§3.5.3) |
| `PUT /api/cours/:code/notes/:id` | `enseignant` affecté au cours | Saisie revalidée côté serveur |

Dans la démonstration, tout enseignant est affecté au cours `RES301`. Chaque étudiant reçoit une fiche à sa première connexion.

### Contrôles appliqués à chaque requête

`server/jwt.js` applique, dans l'ordre, les contrôles du §3.6.2 :

1. **Format** : trois segments Base64URL.
2. **Algorithme** : seul `RS256` est accepté ; `none` et `HS256` sont refusés.
3. **Signature** : vérifiée avec la clé publique du tenant, téléchargée depuis `https://<tenant>/.well-known/jwks.json` et gardée en cache 10 minutes.
4. **Émetteur** : `iss` doit valoir `https://<tenant>/`.
5. **Audience** : `aud` doit contenir l'identifiant de l'API, ce qui exclut l'ID token.
6. **Expiration** : `exp` (et `nbf`), avec une tolérance de 60 s pour les écarts d'horloge.

Viennent ensuite les contrôles métier : rôle, propriété de la fiche, affectation au cours. Chaque réponse renvoie la liste `checks` des contrôles effectués, affichée par la console API.

| Réponse | Signification |
| --- | --- |
| `200` | Jeton valide et action autorisée |
| `401` + `WWW-Authenticate` | Jeton absent, falsifié, expiré, mauvais émetteur ou mauvaise audience |
| `403` | Jeton valide mais rôle, propriété ou affectation insuffisants |
| `502` | Clés publiques du tenant injoignables : DNS, proxy ou pare-feu sortant |

Le terminal du serveur journalise chaque requête (méthode, route, statut, durée), jamais le jeton (§3.5.5).

### Console API

Le tableau de bord propose six scénarios qui envoient de vraies requêtes :

| Scénario | Résultat attendu |
| --- | --- |
| Requête légitime | 200 |
| Sans jeton | 401 |
| Jeton falsifié : rôles modifiés, signature d'origine conservée | 401, signature invalide |
| ID token envoyé à la place de l'access token | 401, mauvaise audience |
| Fiche d'un autre étudiant, ou cours non affecté pour un enseignant | 403 |
| Action réservée à l'autre rôle | 403 |

En production, on confierait ces contrôles à une bibliothèque éprouvée (`jose`, `express-oauth2-jwt-bearer`) ; le code est écrit à la main ici pour que chaque contrôle reste visible.

---

## Mise en ligne sur Render

Render exécute `npm start` tel quel : frontend, API, console et synchronisation des notes fonctionnent comme en local, avec un certificat HTTPS fourni automatiquement. Le fichier `render.yaml`, à la racine du dépôt, décrit le service.

### 1. Préparer le dépôt

Renseignez `domain` et `clientId` dans `js/auth.js`, puis poussez sur la branche `main`. Ces deux valeurs sont des identifiants publics : elles peuvent figurer dans le dépôt. Aucun secret n'est nécessaire.

### 2. Créer le service

1. Créez un compte sur [render.com](https://render.com) et connectez votre compte GitHub.
2. **New > Blueprint**, choisissez le dépôt `Implementation-Expose-Reseau`, puis **Apply**.
3. Render lit `render.yaml`, installe et démarre le service. Au bout d'une à deux minutes, l'adresse publique s'affiche, par exemple `https://uniportal.onrender.com`.

Sans Blueprint, l'équivalent manuel est : **New > Web Service**, *Root Directory* `uniportal`, *Build Command* `npm install`, *Start Command* `npm start`, *Health Check Path* `/api/sante`.

### 3. Déclarer l'adresse dans Auth0

Dans **Applications > UniPortal > Settings**, ajoutez l'adresse Render à la suite des valeurs locales, séparées par des virgules :

| Champ | Valeur à ajouter |
| --- | --- |
| Allowed Callback URLs | `https://uniportal.onrender.com/callback.html` |
| Allowed Logout URLs | `https://uniportal.onrender.com/index.html` |
| Allowed Web Origins | `https://uniportal.onrender.com` |
| Allowed Origins (CORS) | `https://uniportal.onrender.com` |

Remplacez `uniportal` par le nom réellement attribué par Render, puis enregistrez.

### 4. Vérifier

- `https://<votre-service>.onrender.com/api/sante` doit renvoyer `{"status":"ok", ...}` avec le bon émetteur.
- La connexion doit ramener sur `callback.html`, puis sur le tableau de bord avec la pastille « Données servies par l'API ».

### Points d'attention

- **Mise en veille :** l'offre gratuite endort le service après une quinzaine de minutes sans trafic. La première requête suivante prend alors environ une minute. Ouvrez le site quelques minutes avant l'exposé.
- **Données :** les notes sont en mémoire et sont réinitialisées à chaque redémarrage ou mise en veille.
- **Autre hébergeur :** Railway convient aussi. Créez un projet depuis le dépôt et réglez le *Root Directory* sur `uniportal` ; la commande `npm start` est détectée automatiquement.

---

## Démonstration conseillée

1. Ouvrir les outils de développement, onglet **Réseau**, avec l'option « Conserver le journal ».
2. Cliquer sur **Se connecter** : observer `GET /authorize` et ses paramètres `code_challenge`, `state` et `nonce`.
3. Se connecter : observer la redirection `302` vers `callback.html?code=...&state=...`, puis `POST /oauth/token` avec `code_verifier`.
4. Sur le tableau de bord, comparer l'ID token et l'access token dans l'inspecteur JWT : `aud` diffère, et la claim des rôles est présente dans les deux.
5. Dans la console API, rejouer les six scénarios en commentant le contrôle qui échoue. Le scénario « Jeton falsifié » montre qu'un jeton lisible n'est pas un jeton fiable.
6. Ouvrir un second navigateur (ou une fenêtre privée) avec un compte enseignant, saisir une note, puis recharger la page de l'étudiant : la note est servie par l'API.
7. Changer le rôle de l'utilisateur dans Auth0, se déconnecter puis se reconnecter : la vue change.
8. Montrer **Monitoring > Logs** dans le tableau de bord Auth0 et le journal du terminal (§3.5.5).

## Dépannage

| Symptôme | Cause probable | Vérification |
| --- | --- | --- |
| Bandeau « Auth0 n'est pas encore configuré » | Placeholders encore présents | `domain` et `clientId` dans `js/auth.js` |
| `Callback URL mismatch` | URL de retour non autorisée | Étape 4, comparer l'URL exacte |
| Page Auth0 inaccessible | DNS, proxy, pare-feu, certificat | `nslookup <tenant>`, accès HTTPS sur TCP/443 (§3.7.7) |
| Rôle toujours « Étudiant » | Action non attachée ou rôle non assigné | Étapes 7 et 8, puis se reconnecter |
| Access token « opaque » dans l'inspecteur | Audience absente ou incorrecte | Étape 6, valeur `audience` |
| `Invalid state` au callback | Page rechargée ou transaction expirée | Relancer la connexion depuis l'accueil |
| « Mode local : API non démarrée » | Site servi par Python ou live-server | Lancer `npm start` et ouvrir le site depuis ce serveur |
| 403 sur toutes les routes de l'API | Aucun rôle dans l'access token | Étapes 7 et 8 ; l'Action doit écrire dans `api.accessToken` |
| 401 « audience » sur une requête légitime | `audience` différente entre Auth0 et `js/auth.js` | Étape 6, puis se reconnecter |
| 502 côté API | Le serveur ne joint pas le JWKS du tenant | DNS et HTTPS sortant depuis la machine du serveur (§3.7.3) |

## Limites de la démonstration

Les notes sont fictives et stockées en mémoire par le serveur : elles sont perdues à son arrêt. Le serveur écoute en HTTP sur `localhost`, ce qui convient à une démonstration locale ; en production, il serait placé derrière HTTPS (§3.7.2). Le contrôle des rôles côté interface n'est qu'un confort d'affichage : la décision appartient à l'API, qui valide l'access token et vérifie que l'utilisateur a le droit d'accéder à la ressource demandée (§3.1.4, §3.9).
