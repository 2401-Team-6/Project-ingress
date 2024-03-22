import dotenv from "dotenv";
dotenv.config();

import { Task } from "graphile-worker";
import { isValidFunctionPayload, isValidRpcResponse } from "../utils/utils";
import { v4 } from "uuid";

import log from "../utils/logUtils";

const functionServerUrl: string = process.env.FUNCTION_SERVER_URL ?? "";
if (!functionServerUrl) {
  throw new Error("No function server URL found");
}

const process_job: Task = async function (job, helpers) {
  const { payload, attempts, max_attempts } = helpers.job;

  if (!isValidFunctionPayload(job)) {
    const e = new Error(`${job} not valid Function Payload`);
    log.error("Not a valid Function Payload", {
      error: e,
      payload,
      attempts,
      max_attempts,
    });
    throw e;
  }
  let data: any;
  try {
    const response = await fetch(functionServerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: job.name,
        id: job.id,
        params: { event: job.event, cache: job.cache },
      }),
    });

    data = await response.json();
  } catch (e) {
    log.error("Error communicating with function server", {
      funcId: job.id,
      eventId: job.event.id,
      error: e,
      payload,
      attempts,
      max_attempts,
    });
    if (e instanceof Error)
      e.message = "Error communicating with function server";
    throw e;
  }

  if (!isValidRpcResponse(data)) {
    const e = new Error(
      "Did not receive a valid RPC response from function server"
    );

    log.error("Did not receive a valid RPC response from function server", {
      funcId: job.id,
      eventId: job.event.id,
      response: data,
      error: e,
      payload,
      attempts,
      max_attempts,
    });

    throw e;
  }
  if ("error" in data) {
    if (typeof data.error === "string") {
      let e;
      let logMessage = "RPC Response contains an error.";

      try {
        const parsed = JSON.parse(data.error);
        if ("message" in parsed && "stack" in parsed) {
          e = new Error(parsed.message);
          e.stack = parsed.stack;
        }
      } catch {}

      if (!e) {
        e = new Error(data.error);
        logMessage = "RPC Response contains an improperly formatted error.";
      }

      log.error(logMessage, {
        funcId: job.id,
        eventid: job.event.id,
        error: e,
        payload,
        attempts,
        max_attempts,
      });

      throw e;
    } else {
      log.error("RPC Response contains an error.", {
        funcId: job.id,
        eventid: job.event.id,
        error: data.error,
        payload,
        attempts,
        max_attempts,
      });

      throw data.error;
    }
  }

  if (!data.result) {
    log.warn("No result data in RPC response", {
      funcId: job.id,
      eventId: job.event.id,
    });
    return;
  }

  const result = data.result;
  switch (result.type) {
    case "complete":
      log.info("Function completed", { funcId: job.id, eventId: job.event.id });
      return;
    case "step":
      job.cache[result.stepId] = result.stepValue;
      helpers.addJob("process_job", job);

      log.info("Step complete", {
        funcId: job.id,
        eventId: job.event.id,
        stepId: result.stepId,
        stepValue: result.stepValue,
      });
      break;
    case "delay":
      const time = new Date(Date.now() + result.delayInMs);
      job.cache[result.stepId] = time;
      helpers.addJob("process_job", job, { runAt: time });

      log.info("Delay initiated", {
        funcId: job.id,
        eventId: job.event.id,
        stepId: result.stepId,
        delay: result.delayInMs,
      });

      break;
    case "invoke":
      const funcId = v4();
      helpers.addJob("process_job", {
        name: result.invokedFnName,
        id: funcId,
        event: {
          name: `invoked from ${job.name}`,
          id: job.event.id,
          payload: result.payload,
        },
        cache: {},
      });
      log.info("Function invoked", {
        funcId: funcId,
        eventId: job.event.id,
        funcName: result.invokedFnName,
      });

      job.cache[result.stepId] = `${result.invokedFnName} was invoked`;
      helpers.addJob("process_job", job);
      log.info("Invoked step complete", {
        funcId: job.id,
        eventId: job.event.id,
        stepId: result.stepId,
        invokedFnId: funcId,
      });
      break;
    case "emitEvent":
      const eventId = v4();
      helpers.addJob("process_event", {
        name: result.eventId,
        id: eventId,
        payload: result.payload,
      });
      job.cache[result.stepId] = `${result.eventId} was emitted`;
      helpers.addJob("process_job", job);

      log.info("Event emitted", {
        funcId: job.id,
        eventId: job.event.id,
        stepId: result.stepId,
        emittedEventId: eventId,
      });
      break;
    default:
      const _exhaustiveCheck: never = result;
      return _exhaustiveCheck;
  }
};

export default process_job;
