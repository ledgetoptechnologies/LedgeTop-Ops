import { describe, expect, it } from 'vitest';
import { validateIntelObservation } from '../src/worker/competitor-intel-ingest-schema';

const at = '2026-10-22T23:30:00Z';
function selfAssessment(subjectKey = 'self:synthetic') {
  const score = () => ({ value: null, scale: 'concern_0_10', state: 'unknown', reason: 'not_checked', confidence: null });
  return {
    schemaVersion: 'ci.observation.v1', producerId: 'hermes-competitor-intel',
    operationId: '00000000-0000-4000-8000-000000000001', monitoringBindingId: 'binding-synthetic',
    configurationRevision: 1, observationKind: 'self_assessment', subjectKey,
    sourceSequence: { epoch: '1', counter: '1' }, commandBinding: null, observedAt: at, completedAt: at,
    semantics: { observation: 'ci.obs.v1', scoring: 'concern_0_10.v1' },
    payload: { scopeKey: 'synthetic', assessedAt: at, positioning: score(), serviceCoverage: score(),
      geographicMessaging: score(), pricingClarity: score(), differentiation: score(), competitiveReadiness: score(),
      overall: score(), strengths: [], weaknesses: [], recommendedActions: [] },
  };
}
describe('frozen v1 self-assessment subject identity', () => {
  it('accepts the exact self:<scopeKey> subject', () => {
    expect(validateIntelObservation(selfAssessment(), 'hermes-competitor-intel', Date.parse(at)).subjectKey).toBe('self:synthetic');
  });
  it('rejects a different scope despite a valid self prefix', () => {
    expect(() => validateIntelObservation(selfAssessment('self:other'), 'hermes-competitor-intel', Date.parse(at))).toThrow('schema_invalid');
  });
});
