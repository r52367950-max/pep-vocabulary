/** Practice rubric, separate from composition marks. No photograph is persisted here. */
export const HANDWRITING_DIMENSIONS = ['legibility', 'size-spacing', 'baseline-lines', 'layout-neatness'] as const;
export type WritingHandwritingAssessment = {
  rubricVersion: 'practice-v1'; kind: 'practice-reference'; outOf: 20; score: number | null;
  photoQuality: { status: 'usable' | 'limited' | 'unusable'; issues: string[] };
  dimensions: { id: typeof HANDWRITING_DIMENSIONS[number]; score: number | null; evidence: string; suggestion: string }[];
  summary: string;
};
export type WritingRecognition = {
  text: string; uncertainSpans: { text: string; reason: string }[]; requiresConfirmation: true;
  handwriting: WritingHandwritingAssessment;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number, required = false): v is string => typeof v === 'string' && v.length <= max && (!required || !!v.trim());
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const mark = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 5;
export function validWritingHandwritingAssessment(value: unknown): value is WritingHandwritingAssessment {
  if (!object(value) || !onlyKeys(value, ['rubricVersion','kind','outOf','score','photoQuality','dimensions','summary']) || value.rubricVersion !== 'practice-v1' || value.kind !== 'practice-reference' || value.outOf !== 20 || !text(value.summary, 1500, true)) return false;
  const photo = value.photoQuality;
  if (!object(photo) || !onlyKeys(photo, ['status','issues']) || !['usable','limited','unusable'].includes(String(photo.status)) || !Array.isArray(photo.issues) || photo.issues.length > 12 || !photo.issues.every(v => text(v, 500, true))) return false;
  if (photo.status !== 'usable' && photo.issues.length === 0) return false;
  if (!Array.isArray(value.dimensions) || value.dimensions.length !== 4) return false;
  const ids = new Set<string>(); let total = 0;
  for (const row of value.dimensions) {
    if (!object(row) || !onlyKeys(row, ['id','score','evidence','suggestion']) || !HANDWRITING_DIMENSIONS.includes(row.id as typeof HANDWRITING_DIMENSIONS[number]) || ids.has(String(row.id)) || !text(row.evidence, 1000, true) || !text(row.suggestion, 1000, true)) return false;
    ids.add(String(row.id));
    if (photo.status === 'unusable' ? row.score !== null : !mark(row.score)) return false;
    total += Number(row.score);
  }
  return photo.status === 'unusable' ? value.score === null : value.score === total;
}
export function parseWritingRecognition(content: string): WritingRecognition {
  const raw: unknown = JSON.parse(content);
  if (!object(raw) || !text(raw.text, 16000) || !Array.isArray(raw.uncertainSpans) || raw.uncertainSpans.length > 100 || !raw.uncertainSpans.every(v => object(v) && text(v.text, 500, true) && text(v.reason, 500, true))) throw new Error('Invalid literal transcription');
  // Compute the total ourselves. The model cannot inflate an overall mark independently.
  if (!object(raw.handwriting) || !Array.isArray(raw.handwriting.dimensions)) throw new Error('Invalid handwriting assessment');
  const source = raw.handwriting;
  const dimensions = (source.dimensions as unknown[]).map(row => {
    if (!object(row)) throw new Error('Invalid handwriting dimension');
    return { id: row.id, score: row.score, evidence: row.evidence, suggestion: row.suggestion };
  });
  if (!object(source.photoQuality)) throw new Error('Invalid photograph quality');
  const handwriting = {
    rubricVersion: 'practice-v1', kind: 'practice-reference', outOf: 20,
    score: source.photoQuality.status === 'unusable' ? null : dimensions.reduce((sum, row) => sum + Number(row.score), 0),
    photoQuality: { status: source.photoQuality.status, issues: source.photoQuality.issues },
    dimensions, summary: source.summary,
  };
  if (!validWritingHandwritingAssessment(handwriting)) throw new Error('Invalid handwriting assessment');
  return { text: raw.text, uncertainSpans: (raw.uncertainSpans as WritingRecognition['uncertainSpans']).map(({text,reason}) => ({text,reason})), requiresConfirmation: true, handwriting };
}
const string = { type: 'string' };
const score = { type: ['integer','null'], minimum: 0, maximum: 5 };
const strictObject = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const WRITING_RECOGNITION_SCHEMA = strictObject({
  text: string, uncertainSpans: { type:'array', items: strictObject({ text:string, reason:string }) },
  handwriting: strictObject({
    photoQuality: strictObject({ status:{ type:'string', enum:['usable','limited','unusable'] }, issues:{ type:'array',items:string } }),
    dimensions: { type:'array', items:strictObject({ id:{type:'string',enum:HANDWRITING_DIMENSIONS},score,evidence:string,suggestion:string }) }, summary:string,
  }),
});
