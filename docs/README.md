# Documentation du projet UniPortal

Chapitre 4 du rapport : mise en œuvre d'Auth0 dans UniPortal. Il fait suite au chapitre 3, « Présentation générale d'Auth0 ».

| Fichier | Contenu |
| --- | --- |
| `Chapitre4_UniPortal.md` | Source du chapitre, lisible directement sur GitHub |
| `Chapitre4_UniPortal.docx` | Version Word mise en page, à insérer dans le rapport |
| `images/` | Figures 4.1 à 4.12 : schémas et captures d'écran |
| `schemas/schemas.html` | Source des schémas (figures 4.1 à 4.3) |
| `schemas/export.mjs` | Export des schémas en PNG |
| `outils/build-docx.cjs` | Génération du `.docx` à partir du Markdown |

## Insérer le chapitre dans le rapport

Le document Word utilise les styles de titre intégrés (Titre 1 à 3). Une fois le chapitre copié dans le rapport, la table des matières du rapport le prend en compte : clic droit sur la table, puis « Mettre à jour les champs ».

## Régénérer les fichiers

Après une modification du Markdown :

```bash
npm install docx            # une seule fois
node docs/outils/build-docx.cjs
```

Après une modification des schémas :

```bash
npm install playwright      # une seule fois
node docs/schemas/export.mjs
```
