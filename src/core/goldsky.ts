const GOLDSKY_URL = "https://api.goldsky.com/api/public/project_cmp5ztad7km2b01uk2nwo0lpu/subgraphs/scout-registry/1.0.1/gn";

export async function getOpenTasksFromGoldsky(): Promise<Array<{
  taskId: string;
  agent: string;
  taskType: string;
  paymentAmount: string;
  createdAt: string;
}>> {
  const query = `{
    taskCreateds(orderBy: createdAt, orderDirection: desc, first: 20) {
      taskId
      agent
      taskType
      paymentAmount
      createdAt
    }
  }`;

  const response = await fetch(GOLDSKY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = await response.json() as {
    data?: { taskCreateds?: Array<{
      taskId: string;
      agent: string;
      taskType: string;
      paymentAmount: string;
      createdAt: string;
    }> }
  };
  return data.data?.taskCreateds ?? [];
}

export async function getCompletedTasksFromGoldsky(): Promise<Array<{
  taskId: string;
  scout: string;
  confidenceScore: string;
  paymentAmount: string;
}>> {
  const query = `{
    scoutTaskCompleteds(orderBy: blockTimestamp, orderDirection: desc, first: 20) {
      taskId
      scout
      confidenceScore
      paymentAmount
    }
  }`;

  const response = await fetch(GOLDSKY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = await response.json() as {
    data?: { scoutTaskCompleteds?: Array<{
      taskId: string;
      scout: string;
      confidenceScore: string;
      paymentAmount: string;
    }> }
  };
  return data.data?.scoutTaskCompleteds ?? [];
}