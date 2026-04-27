import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ProxyRequest {
  endpoint?: string;
  apiVersion?: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = (await req.json()) as ProxyRequest;
    const {
      endpoint = "https://jls.openai.azure.com/",
      apiVersion = "2025-04-01-preview",
      apiKey,
      model,
      messages,
      maxTokens = 16384,
      temperature,
    } = body;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing apiKey" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!model) {
      return new Response(
        JSON.stringify({ error: "Missing model" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing or empty messages array" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const cleanEndpoint = endpoint.replace(/\/+$/, "");
    const effectiveApiVersion = apiVersion === "2025-04-01-preview" ? "2024-10-21" : apiVersion;
    const url = `${cleanEndpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(effectiveApiVersion)}`;

    const isReasoningModel = /^o\d|^gpt-5/i.test(model);
    const requestBody: Record<string, unknown> = { messages };
    if (isReasoningModel) {
      requestBody.max_completion_tokens = maxTokens;
    } else {
      requestBody.max_tokens = maxTokens;
      if (typeof temperature === "number") requestBody.temperature = temperature;
    }

    const azureRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    const text = await azureRes.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!azureRes.ok) {
      return new Response(
        JSON.stringify({
          error: `Azure OpenAI ${azureRes.status}`,
          detail: parsed?.error?.message || parsed?.error || text.slice(0, 1000),
          status: azureRes.status,
        }),
        { status: azureRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const content =
      parsed?.choices?.[0]?.message?.content ||
      parsed?.choices?.[0]?.text ||
      parsed?.output?.[0]?.content?.[0]?.text ||
      parsed?.output_text ||
      "";

    const tokens = parsed?.usage?.total_tokens || 0;

    return new Response(
      JSON.stringify({ success: true, content, tokens, raw: parsed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: "Proxy error", detail: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
