/**
 * UniPortal API - Donnees de demonstration (en memoire)
 * ==========================================================================
 * Remplace une base de donnees. Tout est perdu a l'arret du serveur.
 *
 * Chaque utilisateur Auth0 ayant le role "etudiant" recoit, a sa premiere
 * requete, une fiche personnelle rattachee a sa claim "sub". C'est cette
 * association sub -> fiche qui permet a l'API de verifier la propriete des
 * donnees (§3.9 : "vérifier l'identité et la propriété des données").
 */

import { createHash } from 'node:crypto';

/** Catalogue des cours du semestre. */
export const COURSES = {
  RES301: { code: 'RES301', matiere: 'Administration réseau', enseignant: 'M. Diallo', coef: 4 },
  SEC302: { code: 'SEC302', matiere: 'Sécurité des systèmes', enseignant: 'Mme Nguyen', coef: 3 },
  WEB303: { code: 'WEB303', matiere: 'Développement web', enseignant: 'M. Martin', coef: 3 },
  BDD304: { code: 'BDD304', matiere: 'Bases de données', enseignant: 'Mme Kouassi', coef: 2 },
  SYS305: { code: 'SYS305', matiere: 'Systèmes d\'exploitation', enseignant: 'M. Bernard', coef: 2 },
  ANG306: { code: 'ANG306', matiere: 'Anglais technique', enseignant: 'Mme Smith', coef: 1 },
};

/**
 * Cours affectes a un enseignant. Dans la demonstration, tout enseignant
 * assure RES301 : demander un autre cours renvoie 403 (autorisation fine,
 * §3.5.3).
 */
export const TEACHER_COURSES = ['RES301'];

/** Notes attribuees a une nouvelle fiche etudiante (RES301 reste a saisir). */
const DEFAULT_GRADES = { RES301: null, SEC302: 13.25, WEB303: 16, BDD304: 11, SYS305: 8.75, ANG306: null };

/** Fiches etudiantes, indexees par numero d'etudiant. */
const students = new Map([
  ['E2024-014', { id: 'E2024-014', nom: 'Awa Traoré', groupe: 'TD1', sub: null, notes: { ...DEFAULT_GRADES, RES301: 15.5 } }],
  ['E2024-027', { id: 'E2024-027', nom: 'Lucas Petit', groupe: 'TD1', sub: null, notes: { ...DEFAULT_GRADES, RES301: 12 } }],
  ['E2024-031', { id: 'E2024-031', nom: 'Inès Benali', groupe: 'TD2', sub: null, notes: { ...DEFAULT_GRADES } }],
  ['E2024-042', { id: 'E2024-042', nom: 'Moussa Keita', groupe: 'TD2', sub: null, notes: { ...DEFAULT_GRADES, RES301: 9.5 } }],
  ['E2024-063', { id: 'E2024-063', nom: 'Yann Mbappe', groupe: 'TD2', sub: null, notes: { ...DEFAULT_GRADES, RES301: 17.25 } }],
]);

/**
 * Renvoie la fiche de l'etudiant connecte, en la creant au besoin.
 * Le numero est derive du sub : il est stable pour un meme compte Auth0.
 *
 * @param {object} claims claims de l'access token valide
 * @returns {object} fiche etudiante
 */
export function studentForUser(claims) {
  for (const s of students.values()) {
    if (s.sub === claims.sub) return s;
  }
  const hash = createHash('sha256').update(claims.sub).digest('hex').slice(0, 4).toUpperCase();
  const student = {
    id: `E2026-${hash}`,
    // L'access token ne porte le nom que si l'Action post-login l'ajoute (README, etape 9).
    nom: claims['https://uniportal.example.com/name'] || claims.name || 'Étudiant connecté',
    groupe: 'TD1',
    sub: claims.sub,
    notes: { ...DEFAULT_GRADES },
  };
  students.set(student.id, student);
  return student;
}

/** Recherche une fiche par numero d'etudiant. */
export function findStudent(id) {
  return students.get(id);
}

/**
 * Releve de notes d'un etudiant, enrichi des informations de cours.
 * @param {object} student
 */
export function transcript(student) {
  const notes = Object.values(COURSES).map((c) => ({ ...c, note: student.notes[c.code] ?? null }));
  const graded = notes.filter((n) => n.note !== null);
  const totalCoef = graded.reduce((sum, n) => sum + n.coef, 0);
  const moyenne = totalCoef ? graded.reduce((sum, n) => sum + n.note * n.coef, 0) / totalCoef : null;
  return {
    etudiant: { id: student.id, nom: student.nom, groupe: student.groupe },
    moyenne,
    notes,
  };
}

/** Liste des etudiants inscrits a un cours, avec leur note dans ce cours. */
export function courseRoster(code) {
  return {
    cours: COURSES[code],
    etudiants: [...students.values()].map((s) => ({ id: s.id, nom: s.nom, groupe: s.groupe, note: s.notes[code] ?? null })),
  };
}

/** Enregistre une note. */
export function setGrade(code, studentId, note) {
  students.get(studentId).notes[code] = note;
}
