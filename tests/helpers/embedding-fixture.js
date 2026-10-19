// Vectores de prueba, no un modelo ni evaluación de calidad semántica.
export function fixtureEmbedding(text) {
  const axis = /solar|energía|energia|sol\b/i.test(text) ? 0 : /planta|fotosíntesis|vegetal/i.test(text) ? 1 : 2;
  return Array.from({ length: 1024 },(_,index) => Number(index === axis));
}
export const fixtureEmbedder = async texts => texts.map(fixtureEmbedding);
