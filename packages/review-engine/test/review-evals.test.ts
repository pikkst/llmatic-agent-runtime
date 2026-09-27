import { describe, expect, it } from "vitest";
import { evaluateReviewCases } from "../src/review-evals.js";

describe("review eval metrics", () => {
  it("scores the known R1 regression corpus without rewarding empty negative cases", () => {
    const metrics = evaluateReviewCases([
      {
        id: "PR-214",
        expectedFindingKeys: ["truncated-history"],
        actualFindingKeys: ["truncated-history"],
      },
      {
        id: "PR-215",
        expectedFindingKeys: [],
        actualFindingKeys: [],
      },
      {
        id: "PR-240",
        expectedFindingKeys: ["locale-plural-family"],
        actualFindingKeys: ["locale-plural-family"],
      },
    ]);

    expect(metrics).toMatchObject({
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });
  });

  it("exposes precision and recall regressions independently", () => {
    const metrics = evaluateReviewCases([
      {
        id: "mixed",
        expectedFindingKeys: ["real-a", "real-b"],
        actualFindingKeys: ["real-a", "false-c"],
      },
    ]);

    expect(metrics.truePositives).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.f1).toBe(0.5);
  });
});
