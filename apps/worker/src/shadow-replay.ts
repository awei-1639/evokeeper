/**
 * 影子回放（W6 第 6 道门禁）—— design.md §7.2
 *
 * "历史轨迹影子回放：新版本在旧轨迹上离线重跑"。输入是历史轨迹的 issue 快照
 * （title/body）与其历史处置结果（主标签），候选版本在同样的输入上重跑，
 * 比对与历史结果的一致率——防止新经验让"以前处理对的问题"变错（回归的另一种形态）。
 *
 * 通过判据：一致率 ≥ minAgreementRate（provisional 0.95，W4 真实流量后校准）。
 * 解析失败（null）计为不一致——判错不豁免，与 §7.1 同口径。
 */
import { mainLabelOf } from "@evokeeper/eval";

export interface ReplaySnapshot {
  caseId: string;
  title: string;
  body: string;
  /** 历史处置的主标签（来自旧版本轨迹的 finalActions） */
  historicalMain: string;
}

export interface ReplayRunnerOutput {
  labels: string[] | null;
}

export interface ShadowReplayReport {
  total: number;
  agreementCount: number;
  agreementRate: number;
  disagreements: Array<{ caseId: string; historical: string; replayed: string | null }>;
  passed: boolean;
  minAgreementRate: number;
}

export async function replayShadow(args: {
  snapshots: readonly ReplaySnapshot[];
  /** 候选版本的执行入口（与线上同入口、dry-run，不写 GitHub） */
  runVersion: (snapshot: ReplaySnapshot) => Promise<ReplayRunnerOutput>;
  minAgreementRate?: number;
}): Promise<ShadowReplayReport> {
  const minAgreementRate = args.minAgreementRate ?? 0.95;
  const disagreements: ShadowReplayReport["disagreements"] = [];
  let agreementCount = 0;

  for (const snapshot of args.snapshots) {
    const output = await args.runVersion(snapshot);
    const replayed = output.labels && output.labels.length > 0 ? mainLabelOf(output.labels) : null;
    if (replayed !== null && replayed === mainLabelOf([snapshot.historicalMain])) {
      agreementCount++;
    } else {
      disagreements.push({ caseId: snapshot.caseId, historical: snapshot.historicalMain, replayed });
    }
  }

  const total = args.snapshots.length;
  const agreementRate = total > 0 ? agreementCount / total : 1;
  return {
    total,
    agreementCount,
    agreementRate,
    disagreements,
    passed: agreementRate >= minAgreementRate,
    minAgreementRate,
  };
}
