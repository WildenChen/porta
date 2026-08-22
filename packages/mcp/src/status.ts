import type { LSInstance } from "@porta/proxy/discovery.js";
import { rpcForConversation, getStepCount } from "@porta/proxy/routing.js";
import {
  oversizedStepOffset,
  isRecoverableStepError,
  findNextValidOffset,
  placeholderStep,
  MAX_SKIP,
} from "@porta/proxy/step-recovery.js";

export type SimplifiedStatus =
  | "running"
  | "waiting_for_command_approval"
  | "waiting_for_file_permission"
  | "waiting_for_question"
  | "completed"
  | "failed"
  | "cancelled"
  | "unloaded";

export interface StepInteractionInfo {
  type: "command" | "file_permission" | "question";
  trajectoryId: string;
  stepIndex: number;
  commandLine?: string;
  absolutePathUri?: string;
  scope?: number;
  action?: string;
  questions?: unknown[];
}

export interface SimplifiedStatusResult {
  conversationId: string;
  status: SimplifiedStatus;
  rawStatus?: string;
  stepCount: number;
  latestStep?: Record<string, unknown>;
  summary?: string;
  requiredInteraction?: StepInteractionInfo;
}

export async function fetchConversationSteps(
  cascadeId: string,
  options: {
    offset?: number;
    limit?: number;
    tail?: number;
    targetApp?: string;
  } = {},
): Promise<{ steps: Record<string, unknown>[]; offset: number; stepCount: number }> {
  const { targetApp } = options;
  let resolvedOffset = options.offset ?? 0;
  const sc = targetApp
    ? await getStepCount(cascadeId, undefined, true, targetApp)
    : await getStepCount(cascadeId, undefined, true);
  const stepCount = sc.count;
  let pinnedInstance: LSInstance | undefined = sc.instance;

  if (options.tail !== undefined && options.tail > 0) {
    const tailSize = Math.min(options.tail, 500);
    resolvedOffset = Math.max(0, stepCount - tailSize);
  }

  const targetLimit = options.limit !== undefined ? Math.min(options.limit, 500) : Math.max(1, stepCount - resolvedOffset);
  const stepsArray: Record<string, unknown>[] = [];
  let currentOffset = resolvedOffset;
  let consecutiveSkips = 0;

  const pushPlaceholders = (count: number, reason: string) => {
    const remainingTarget = targetLimit - stepsArray.length;
    const remainingSkips = MAX_SKIP - consecutiveSkips;
    const placeholderCount = Math.max(
      0,
      Math.min(count, remainingTarget, remainingSkips),
    );
    for (let s = 0; s < placeholderCount; s++) {
      stepsArray.push(placeholderStep(reason) as Record<string, unknown>);
    }
  };

  while (stepsArray.length < targetLimit) {
    try {
      const data = targetApp
        ? await rpcForConversation<{ steps?: Record<string, unknown>[] }>(
            "GetCascadeTrajectorySteps",
            cascadeId,
            { cascadeId, stepOffset: currentOffset },
            pinnedInstance,
            true,
            targetApp,
          )
        : await rpcForConversation<{ steps?: Record<string, unknown>[] }>(
            "GetCascadeTrajectorySteps",
            cascadeId,
            { cascadeId, stepOffset: currentOffset },
            pinnedInstance,
            true,
          );

      const chunk = data.steps ?? [];
      if (chunk.length === 0) break;
      stepsArray.push(...chunk);
      currentOffset += chunk.length;
      consecutiveSkips = 0;
    } catch (fetchErr) {
      const badOffset = oversizedStepOffset(fetchErr);
      if (badOffset >= 0) {
        const skipCount = badOffset - currentOffset + 1;
        pushPlaceholders(
          skipCount,
          "Language Server: step exceeds 4MB protobuf limit",
        );
        currentOffset = badOffset + 1;
        consecutiveSkips += skipCount;
        if (consecutiveSkips >= MAX_SKIP) break;
      } else if (isRecoverableStepError(fetchErr)) {
        const nextValid = await findNextValidOffset(
          cascadeId,
          currentOffset + 1,
          stepCount,
          pinnedInstance,
        );
        const skipCount = nextValid - currentOffset;
        pushPlaceholders(
          skipCount,
          "Language Server: invalid UTF-8 in step data",
        );
        currentOffset = nextValid;
        consecutiveSkips += skipCount;
        if (consecutiveSkips >= MAX_SKIP) break;
      } else {
        throw fetchErr;
      }
    }
  }

  const finalSteps = stepsArray.length > targetLimit ? stepsArray.slice(0, targetLimit) : stepsArray;
  return {
    steps: finalSteps,
    offset: resolvedOffset,
    stepCount,
  };
}

export function detectRequiredInteraction(step: Record<string, unknown>): StepInteractionInfo | undefined {
  const status = step.status as string | undefined;
  if (status !== "CORTEX_STEP_STATUS_WAITING") {
    return undefined;
  }

  const metadata = (step.metadata ?? {}) as Record<string, unknown>;
  const sourceTrajectoryStepInfo = (metadata.sourceTrajectoryStepInfo ?? {}) as Record<string, unknown>;
  const trajectoryId = (sourceTrajectoryStepInfo.trajectoryId as string) || "";
  const stepIndex = typeof sourceTrajectoryStepInfo.stepIndex === "number" ? sourceTrajectoryStepInfo.stepIndex : 0;

  // 1. Command approval
  const runCommand = step.runCommand as Record<string, unknown> | undefined;
  if (runCommand) {
    const commandLine =
      (runCommand.proposedCommandLine as string) ||
      (runCommand.commandLine as string) ||
      (runCommand.command as string) ||
      "";
    return {
      type: "command",
      trajectoryId,
      stepIndex,
      commandLine,
    };
  }

  // 2. File permission request
  const filePermissionRequest = step.filePermissionRequest as Record<string, unknown> | undefined;
  if (filePermissionRequest && typeof filePermissionRequest.absolutePathUri === "string") {
    return {
      type: "file_permission",
      trajectoryId,
      stepIndex,
      absolutePathUri: filePermissionRequest.absolutePathUri,
      scope: typeof filePermissionRequest.scope === "number" ? filePermissionRequest.scope : 0,
      action: (filePermissionRequest.action as string) || undefined,
    };
  }

  // 3. Ask question
  const askQuestion = (step.askQuestion ?? step.requestedInteraction) as Record<string, unknown> | undefined;
  const questions = (askQuestion?.questions ?? (askQuestion as any)?.askQuestion?.questions) as unknown[] | undefined;
  if (askQuestion || (step.type as string)?.includes("ASK_QUESTION")) {
    return {
      type: "question",
      trajectoryId,
      stepIndex,
      questions: Array.isArray(questions) ? questions : [],
    };
  }

  return undefined;
}

export function computeSimplifiedStatus(
  conversationId: string,
  trajectory: Record<string, unknown>,
  steps: Record<string, unknown>[],
  stepCount: number,
): SimplifiedStatusResult {
  const rawStatus = (trajectory.status as string) || "";
  const summary = (trajectory.summary as string) || (trajectory.title as string) || undefined;
  const latestStep = steps.length > 0 ? steps[steps.length - 1] : undefined;

  let interaction: StepInteractionInfo | undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    const detected = detectRequiredInteraction(steps[i]);
    if (detected) {
      interaction = detected;
      break;
    }
  }

  let status: SimplifiedStatus = "completed";

  if (rawStatus === "CASCADE_RUN_STATUS_UNLOADED") {
    status = "unloaded";
  } else if (rawStatus === "CASCADE_RUN_STATUS_ERROR") {
    status = "failed";
  } else if (interaction) {
    if (interaction.type === "command") {
      status = "waiting_for_command_approval";
    } else if (interaction.type === "file_permission") {
      status = "waiting_for_file_permission";
    } else if (interaction.type === "question") {
      status = "waiting_for_question";
    }
  } else if (rawStatus === "CASCADE_RUN_STATUS_RUNNING") {
    status = "running";
  } else if (rawStatus === "CASCADE_RUN_STATUS_IDLE") {
    const latestStatus = latestStep?.status as string | undefined;
    if (latestStatus === "CORTEX_STEP_STATUS_CANCELED") {
      status = "cancelled";
    } else if (latestStatus === "CORTEX_STEP_STATUS_ERROR" || latestStatus === "CORTEX_STEP_STATUS_INVALID") {
      status = "failed";
    } else {
      status = "completed";
    }
  }

  return {
    conversationId,
    status,
    rawStatus,
    stepCount,
    latestStep,
    summary,
    requiredInteraction: interaction,
  };
}

export async function getConversationStatus(
  cascadeId: string,
  targetApp?: string,
): Promise<SimplifiedStatusResult> {
  const trajectory = targetApp
    ? await rpcForConversation<Record<string, unknown>>(
        "GetCascadeTrajectory",
        cascadeId,
        { cascadeId },
        undefined,
        true,
        targetApp,
      )
    : await rpcForConversation<Record<string, unknown>>(
        "GetCascadeTrajectory",
        cascadeId,
        { cascadeId },
        undefined,
        true,
      );

  const stepsPage = await fetchConversationSteps(cascadeId, { tail: 20, targetApp });
  return computeSimplifiedStatus(cascadeId, trajectory, stepsPage.steps, stepsPage.stepCount);
}

export async function waitForConversation(
  cascadeId: string,
  options: {
    timeoutSeconds?: number;
    pollIntervalMs?: number;
    targetApp?: string;
  } = {},
): Promise<SimplifiedStatusResult> {
  const timeoutMs = (options.timeoutSeconds ?? 60) * 1000;
  const pollInterval = options.pollIntervalMs ?? 1000;
  const startTime = Date.now();

  while (true) {
    const result = await getConversationStatus(cascadeId, options.targetApp);
    if (result.status !== "running") {
      return result;
    }
    if (Date.now() - startTime >= timeoutMs) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}
