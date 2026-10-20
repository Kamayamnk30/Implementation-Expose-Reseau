/**
 * UniPortal API - Donnees de demonstration (en memoire)
 * ==========================================================================
 * Remplace une base de donnees. Tout est perdu a l'arret du serveur.
 *
 * Modele : un etablissement secondaire, deux classes, huit matieres
 * coefficientees et trois trimestres. Chaque eleve possede, par matiere et
 * par trimestre, une moyenne sur 20 et une appreciation.
 *
 * Chaque utilisateur Auth0 ayant le role "eleve" recoit, a sa premiere
 * requete, une fiche rattachee a sa claim "sub". C'est cette association
 * sub -> fiche qui permet a l'API de verifier la propriete des donnees
 * (§3.9 : "verifier l'identite et la propriete des donnees").
 */

import { createHash } from 'node:crypto';

export const ANNEE = '2025-2026';
export const TRIMESTRES = [1, 2, 3];

/** Matieres du cycle, avec coefficient et professeur referent. */
export const MATIERES = {
  FRA: { code: 'FRA', nom: 'Français', coef: 3, professeur: 'Mme Ndiaye' },
  MATHS: { code: 'MATHS', nom: 'Mathématiques', coef: 4, professeur: 'M. Diallo' },
  PC: { code: 'PC', nom: 'Physique-Chimie', coef: 3, professeur: 'M. Koné' },
  SVT: { code: 'SVT', nom: 'Sciences de la vie et de la Terre', coef: 2, professeur: 'Mme Bamba' },
  HG: { code: 'HG', nom: 'Histoire-Géographie', coef: 2, professeur: 'M. Sow' },
  ANG: { code: 'ANG', nom: 'Anglais', coef: 2, professeur: 'Mme Smith' },
  ESP: { code: 'ESP', nom: 'Espagnol', coef: 1, professeur: 'Mme García' },
  EPS: { code: 'EPS', nom: 'Éducation physique et sportive', coef: 1, professeur: 'M. Camara' },
};

export const CLASSES = {
  '2B': { code: '2B', nom: 'Seconde B' },
  '1A': { code: '1A', nom: 'Première A' },
};

/**
 * Affectations d'un professeur (classe + matiere). Dans la demonstration,
 * tout utilisateur ayant le role "professeur" enseigne les mathematiques en
 * Seconde B et en Premiere A. Toute autre combinaison est refusee (403) :
 * c'est l'autorisation fine du §3.5.3.
 */
export const AFFECTATIONS = [
  { classe: '2B', matiere: 'MATHS' },
  { classe: '1A', matiere: 'MATHS' },
];

/* --------------------------------------------------------------------------
   Generation deterministe des notes
   -------------------------------------------------------------------------- */

/** Generateur pseudo-aleatoire reproductible (mulberry32), amorce par une chaine. */
function seededRandom(seed) {
  let a = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const roundHalf = (n) => Math.round(n * 2) / 2;
const clamp = (n) => Math.min(20, Math.max(0, n));

/**
 * Notes d'un eleve : trimestres 1 et 2 complets, trimestre 3 en cours.
 * Au trimestre 3, les mathematiques restent a saisir par le professeur.
 */
function generateNotes(seed) {
  const rand = seededRandom(seed);
  const niveau = 8 + rand() * 9;
  const notes = {};
  for (const t of TRIMESTRES) {
    notes[t] = {};
    for (const code of Object.keys(MATIERES)) {
      const enCours = t === 3 && (code === 'MATHS' || rand() < 0.4);
      notes[t][code] = enCours
        ? { note: null, appreciation: null }
        : { note: clamp(roundHalf(niveau + (rand() - 0.5) * 7 + (t - 2) * 0.6)), appreciation: null };
    }
  }
  return notes;
}

/* --------------------------------------------------------------------------
   Eleves
   -------------------------------------------------------------------------- */

const STATIC_ELEVES = [
  ['EL-2B-01', 'Aminata Diop', '2B'], ['EL-2B-02', 'Lucas Martin', '2B'], ['EL-2B-03', 'Fatou Sarr', '2B'],
  ['EL-2B-04', 'Ibrahim Touré', '2B'], ['EL-2B-05', 'Chloé Bernard', '2B'], ['EL-2B-06', 'Moussa Keita', '2B'],
  ['EL-2B-07', 'Inès Benali', '2B'], ['EL-2B-08', 'Yann Kouassi', '2B'],
  ['EL-1A-01', 'Mariam Cissé', '1A'], ['EL-1A-02', 'Hugo Lefèvre', '1A'], ['EL-1A-03', 'Awa Traoré', '1A'],
  ['EL-1A-04', 'Omar Fall', '1A'], ['EL-1A-05', 'Léa Dubois', '1A'], ['EL-1A-06', 'Samuel Mensah', '1A'],
];

/** Fiches eleves, indexees par identifiant. */
const eleves = new Map(
  STATIC_ELEVES.map(([id, nom, classe]) => [id, { id, nom, classe, sub: null, notes: generateNotes(id) }]),
);

/**
 * Renvoie la fiche de l'eleve connecte, en la creant au besoin en Seconde B.
 * L'identifiant est derive du sub : il est stable pour un meme compte Auth0.
 *
 * @param {object} claims claims de l'access token valide
 */
export function eleveForUser(claims) {
  for (const e of eleves.values()) {
    if (e.sub === claims.sub) return e;
  }
  const hash = createHash('sha256').update(claims.sub).digest('hex').slice(0, 4).toUpperCase();
  const eleve = {
    id: `EL-${hash}`,
    // Le nom n'est present dans l'access token que si l'Action post-login l'ajoute (README).
    nom: claims['https://uniportal.example.com/name'] || 'Élève',
    classe: '2B',
    sub: claims.sub,
    notes: generateNotes(claims.sub),
  };
  eleves.set(eleve.id, eleve);
  return eleve;
}

export function findEleve(id) {
  return eleves.get(id);
}

function elevesDeClasse(classe) {
  return [...eleves.values()].filter((e) => e.classe === classe);
}

/* --------------------------------------------------------------------------
   Calculs du bulletin
   -------------------------------------------------------------------------- */

const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

/** Moyenne generale ponderee d'un eleve pour un trimestre (null si aucune note). */
function moyenneGenerale(eleve, t) {
  let somme = 0;
  let coefs = 0;
  for (const m of Object.values(MATIERES)) {
    const n = eleve.notes[t][m.code].note;
    if (n !== null) { somme += n * m.coef; coefs += m.coef; }
  }
  return coefs ? somme / coefs : null;
}

function stats(values) {
  const v = values.filter((x) => x !== null);
  if (!v.length) return { moyenne: null, min: null, max: null };
  return { moyenne: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
}

function appreciationAuto(note) {
  if (note === null) return null;
  if (note >= 16) return 'Excellents résultats, félicitations.';
  if (note >= 14) return 'Très bon travail, continuez ainsi.';
  if (note >= 12) return 'Bon ensemble, travail régulier.';
  if (note >= 10) return 'Résultats corrects, peut mieux faire.';
  if (note >= 8) return 'Résultats fragiles, un travail plus soutenu est attendu.';
  return 'Trimestre insuffisant, il faut se ressaisir.';
}

function mention(moyenne) {
  if (moyenne === null) return null;
  if (moyenne >= 16) return 'Félicitations';
  if (moyenne >= 14) return 'Compliments';
  if (moyenne >= 12) return 'Encouragements';
  if (moyenne < 8) return 'Mise en garde';
  return null;
}

/** Bulletin complet d'un eleve pour un trimestre. */
export function bulletin(eleve, t) {
  const classe = elevesDeClasse(eleve.classe);

  const matieres = Object.values(MATIERES).map((m) => {
    const { note, appreciation } = eleve.notes[t][m.code];
    const s = stats(classe.map((e) => e.notes[t][m.code].note));
    return {
      code: m.code, nom: m.nom, coef: m.coef, professeur: m.professeur,
      note, appreciation: appreciation || appreciationAuto(note),
      moyenneClasse: round2(s.moyenne), min: s.min, max: s.max,
    };
  });

  const moyennes = classe.map((e) => ({ id: e.id, m: moyenneGenerale(e, t) })).filter((x) => x.m !== null);
  moyennes.sort((a, b) => b.m - a.m);
  const moyenne = moyenneGenerale(eleve, t);
  const rang = moyenne === null ? null : moyennes.findIndex((x) => x.id === eleve.id) + 1;

  return {
    eleve: { id: eleve.id, nom: eleve.nom, classe: CLASSES[eleve.classe] },
    annee: ANNEE,
    trimestre: t,
    complet: matieres.every((m) => m.note !== null),
    matieres,
    moyenne: round2(moyenne),
    moyenneClasse: round2(stats(moyennes.map((x) => x.m)).moyenne),
    rang,
    effectif: classe.length,
    mention: mention(moyenne),
    appreciationGenerale: appreciationAuto(moyenne),
  };
}

/** Liste des eleves d'une classe pour une matiere et un trimestre (vue professeur). */
export function releveClasse(classe, matiere, t) {
  const liste = elevesDeClasse(classe)
    .map((e) => ({ id: e.id, nom: e.nom, ...e.notes[t][matiere] }))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const s = stats(liste.map((e) => e.note));
  return {
    classe: CLASSES[classe],
    matiere: { code: matiere, nom: MATIERES[matiere].nom, coef: MATIERES[matiere].coef },
    annee: ANNEE,
    trimestre: t,
    eleves: liste,
    moyenneClasse: round2(s.moyenne),
    saisies: liste.filter((e) => e.note !== null).length,
  };
}

/** Enregistre la moyenne et l'appreciation d'un eleve. */
export function enregistrerNote(eleveId, matiere, t, note, appreciation) {
  eleves.get(eleveId).notes[t][matiere] = { note, appreciation: appreciation || null };
}
