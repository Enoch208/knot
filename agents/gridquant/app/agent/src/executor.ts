import { randomUUID } from "node:crypto";
import type { DataPart, Message } from "@a2a-js/sdk";
import {
  A2AError,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { isCommerceRateLimitError } from "./requestLimits.js";
import { SellerCore } from "./sellerCore.js";

const log = {
  error: (msg: string, e?: unknown) =>
    console.error(`[seller-agent.a2a] ERROR ${msg}`, e ?? ""),
};

export class SellerAgentExecutor extends SellerCore implements AgentExecutor {

  async dispatch(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const skill = data.skill;
    try {
      if (skill === "negotiate") {
        return await this.negotiate(data);
      }
      if (skill === "notify_funded") {
        return await this.notifyFunded(data);
      }

      return {
        error: `unknown skill: ${JSON.stringify(skill)}`,
        skills: this.skills(),
      };
    } catch (e) {

      log.error(`skill ${JSON.stringify(skill)} failed`, e);
      if (isCommerceRateLimitError(e)) {
        return { status: "retry", error: "seller rate limit exceeded", skill };
      }
      return { error: "seller operation failed; retry later", skill };
    }
  }

  execute = async (
    context: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> => {
    const data = inbound(context);
    const skill = data.skill;
    let result: Record<string, unknown>;
    try {
      if (skill === "negotiate") {
        result = await this.negotiate(data);
      } else if (skill === "notify_funded") {
        result = await this.notifyFunded(data);
      } else {

        result = {
          error: `unknown skill: ${JSON.stringify(skill)}`,
          skills: this.skills(),
        };
        if (skill === undefined) {

          result.hint =
            'send the skill envelope as an A2A data part: parts:[{"kind":"data","data":{"skill":"negotiate",...}}]';
        }
      }
    } catch (e) {

      log.error(`skill ${JSON.stringify(skill)} failed`, e);
      if (isCommerceRateLimitError(e)) {
        result = {
          status: "retry",
          error: "seller rate limit exceeded",
          skill,
        };
      } else {
        throw A2AError.internalError("seller operation failed; retry later");
      }
    }
    reply(eventBus, context, result);
  };

  cancelTask = async (
    _taskId: string,
    _eventBus: ExecutionEventBus,
  ): Promise<void> => {

    throw A2AError.unsupportedOperation("cancel");
  };
}

function inbound(context: RequestContext): Record<string, unknown> {
  const parts = context.userMessage?.parts ?? [];
  const dataPart = parts.find((p): p is DataPart => p.kind === "data");
  return dataPart?.data ?? {};
}

function reply(
  eventBus: ExecutionEventBus,
  context: RequestContext,
  data: Record<string, unknown>,
): void {
  const message: Message = {
    kind: "message",
    role: "agent",
    messageId: randomUUID(),
    parts: [{ kind: "data", data }],
    contextId: context.contextId,
    taskId: context.taskId,
  };

  eventBus.publish(message);
  eventBus.finished();
}
