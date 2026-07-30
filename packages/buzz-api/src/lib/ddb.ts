import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Project } from "@folstad/buzz-shared";

const table = () => process.env.PROJECTS_TABLE ?? "buzz-projects";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function pk(projectId: string) {
  return `PROJECT#${projectId}`;
}

function ownerPk(sub: string) {
  return `OWNER#${sub}`;
}

export async function putProject(project: Project): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: table(),
      Item: {
        ...project,
        pk: pk(project.projectId),
        sk: "META",
        gsi1pk: ownerPk(project.ownerSub),
        gsi1sk: `CREATED#${project.createdAt}`,
        gsi2pk: `SUBDOMAIN#${project.subdomain}`,
        gsi2sk: "META",
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
}

export async function getProjectById(projectId: string): Promise<Project | null> {
  const res = await doc.send(
    new GetCommand({
      TableName: table(),
      Key: { pk: pk(projectId), sk: "META" },
    }),
  );
  if (!res.Item) return null;
  return itemToProject(res.Item);
}

export async function getProjectBySubdomain(subdomain: string): Promise<Project | null> {
  const res = await doc.send(
    new QueryCommand({
      TableName: table(),
      IndexName: "gsi2",
      KeyConditionExpression: "gsi2pk = :pk",
      ExpressionAttributeValues: { ":pk": `SUBDOMAIN#${subdomain}` },
      Limit: 1,
    }),
  );
  const item = res.Items?.[0];
  return item ? itemToProject(item) : null;
}

export async function listProjectsByOwner(ownerSub: string): Promise<Project[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: table(),
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": ownerPk(ownerSub) },
      ScanIndexForward: false,
    }),
  );
  return (res.Items ?? []).map(itemToProject);
}

export async function updateProject(
  projectId: string,
  patch: Partial<Project> & { failureReason?: string | null },
): Promise<Project | null> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setParts: string[] = [];
  const removeParts: string[] = [];

  for (const [k, v] of Object.entries(patch)) {
    if (k === "projectId") continue;
    // null → REMOVE attribute (e.g. clear failureReason)
    if (v === null) {
      const nk = `#rm_${k}`;
      names[nk] = k;
      removeParts.push(nk);
      continue;
    }
    if (v === undefined) continue;
    const nk = `#${k}`;
    const vk = `:${k}`;
    names[nk] = k;
    values[vk] = v;
    setParts.push(`${nk} = ${vk}`);
  }
  names["#updatedAt"] = "updatedAt";
  values[":updatedAt"] = new Date().toISOString();
  setParts.push("#updatedAt = :updatedAt");

  const expr = [
    setParts.length ? `SET ${setParts.join(", ")}` : "",
    removeParts.length ? `REMOVE ${removeParts.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: table(),
        Key: { pk: pk(projectId), sk: "META" },
        UpdateExpression: expr,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(pk)",
        ReturnValues: "ALL_NEW",
      }),
    );
    return res.Attributes ? itemToProject(res.Attributes) : null;
  } catch {
    return null;
  }
}

function itemToProject(item: Record<string, unknown>): Project {
  const {
    pk: _pk,
    sk: _sk,
    gsi1pk: _g1,
    gsi1sk: _g1s,
    gsi2pk: _g2,
    gsi2sk: _g2s,
    ...rest
  } = item;
  return rest as Project;
}
