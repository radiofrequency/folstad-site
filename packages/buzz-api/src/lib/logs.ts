import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const cw = new CloudWatchLogsClient({});

export async function tailLogs(
  logGroupName: string,
  limit = 200,
): Promise<Array<{ ts: string; message: string }>> {
  try {
    const res = await cw.send(
      new FilterLogEventsCommand({
        logGroupName,
        limit: Math.min(Math.max(limit, 1), 500),
        interleaved: true,
      }),
    );
    const events = res.events ?? [];
    return events
      .map((e) => ({
        ts: e.timestamp ? new Date(e.timestamp).toISOString() : "",
        message: e.message ?? "",
      }))
      .reverse();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "log fetch failed";
    return [{ ts: new Date().toISOString(), message: `[logs] ${msg}` }];
  }
}
