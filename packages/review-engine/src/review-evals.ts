export interface ReviewEvalCase {
  id: string;
  expectedFindingKeys: string[];
  actualFindingKeys: string[];
}

export interface ReviewEvalCaseResult {
  id: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface ReviewEvalMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  cases: ReviewEvalCaseResult[];
}

function unique(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

export function evaluateReviewCases(cases: ReviewEvalCase[]): ReviewEvalMetrics {
  const caseResults = cases.map((testCase) => {
    const expected = unique(testCase.expectedFindingKeys);
    const actual = unique(testCase.actualFindingKeys);

    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const key of actual) {
      if (expected.has(key)) truePositives += 1;
      else falsePositives += 1;
    }
    for (const key of expected) {
      if (!actual.has(key)) falseNegatives += 1;
    }

    return {
      id: testCase.id,
      truePositives,
      falsePositives,
      falseNegatives,
    };
  });

  const truePositives = caseResults.reduce((sum, item) => sum + item.truePositives, 0);
  const falsePositives = caseResults.reduce((sum, item) => sum + item.falsePositives, 0);
  const falseNegatives = caseResults.reduce((sum, item) => sum + item.falseNegatives, 0);
  const precision =
    truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    cases: caseResults,
  };
}
