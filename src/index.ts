export interface Env {
  GITHUB_TOKEN: string; // Pulled dynamically from your secure wrangler secrets
  GITHUB_REPO: string;  // e.g., "timastras9/your-trading-bot-repo"
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. Grant safe global browser access across different subdomains (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 2. THIS HANDLES THE /chat INTERCEPTOR ENDPOINT
    if (url.pathname === "/chat" && request.method === "POST") {
      try {
        const incoming = await request.json() as any;
        const userMessages = incoming.messages || [];

        // Define your strict agent persona rules
        const systemPrompt = `You are Astra, an AI Cryptocurrency Market Analyst. 
You will use the RAG Provided to help analyze crypto data and help find ways to improve our pump.fun crypto short term trading bot.
Analyze data to optimize and find patterns of the losers, adjust a Reinforcement Learning (RL) Model parameters, and optimize a prediction model, data configurations, and trading algorithms.
You have root write access to our GitHub repository. When outputting code updates, wrap the code inside a clean markdown block.`;

        // Compose the hidden instruction block sent to the indexing network
        const cloudflarePayload = {
          model: "openai/gpt-6-astra", // Your custom model routing value
          messages: [
            { role: "system", content: systemPrompt },
            ...userMessages
          ],
          stream: false,
          ai_search_options: {
            query_rewrite: {
              enabled: true,
              model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" // Handles continuous conversational history
            }
          }
        };

        // Fire the request directly to the internal Cloudflare search engine cloud
        const aiSearchResponse = await fetch("https://cloudflare.com", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer AI Search Token - 2026-09-26" // Safe behind the edge wall
          },
          body: JSON.stringify(cloudflarePayload)
        });

        const aiData = await aiSearchResponse.json() as any;
        const assistantMessage = aiData.choices?.[0]?.message?.content || "";

        // ROOT ACCESS PIPELINE: If Astra produces code updates, intercept and commit them to Git
        if (assistantMessage.includes("```python") || assistantMessage.includes("```json")) {
          await pushRootChangesToGitHub(assistantMessage, env);
        }

        return new Response(JSON.stringify(aiData), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });

      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 3. THIS SERVES THE DASHBOARD ON THE ROOT DOMAIN PATH
    return new Response(getDashboardHTML(request.url), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// Root Access Script Writer Strategy Engine
async function pushRootChangesToGitHub(aiOutput: string, env: Env) {
  // Targeting the algorithm core configuration file in your GitHub repo
  const fileTargetUrl = `https://github.com{env.GITHUB_REPO}/contents/config/trading_policy.py`;
  
  // Extract text safely between markdown markers
  let codePayload = aiOutput;
  if (aiOutput.includes("```python")) {
    codePayload = aiOutput.split("```python")[1].split("```")[0].trim();
  }

  // A. Check for existing file SHA version (Required by GitHub API for editing files)
  const currentRefCheck = await fetch(fileTargetUrl, {
    headers: {
      "Authorization": `token ${env.GITHUB_TOKEN}`,
      "User-Agent": "Astra-Core-AI-Agent"
    }
  });

  let latestSha = "";
  if (currentRefCheck.status === 200) {
    const metaData = await currentRefCheck.json() as any;
    latestSha = metaData.sha;
  }

  // B. Deploy code update to root main branch automatically
  await fetch(fileTargetUrl, {
    method: "PUT",
    headers: {
      "Authorization": `token ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "Astra-Core-AI-Agent"
    },
    body: JSON.stringify({
      message: "🤖 Astra AI: Automatic RL prediction engine & algorithmic code optimization patch",
      content: btoa(unescape(encodeURIComponent(codePayload))), // Safe Base64 multi-byte string serialization
      sha: latestSha || undefined
    })
  });
}

// Frontend Render Block Layout
function getDashboardHTML(currentWorkerUrl: string): string {
  const origin = new URL(currentWorkerUrl).origin;
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <title>Momentum Lab — Private Research Desk</title>
      <script type="module" src="https://cloudflare.com"></script>
      <style>
          body { margin: 0; background-color: #080c14; font-family: -apple-system, system-ui, sans-serif; color: #f3f4f6; }
          .header { background-color: #0f172a; padding: 18px 24px; border-bottom: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; }
          .status { background: #065f46; color: #34d399; padding: 5px 14px; border-radius: 30px; font-size: 11px; letter-spacing: 0.5px; font-weight: bold; text-transform: uppercase; }
          chat-page-snippet {
              --search-snippet-primary-color: #f6821f;
              --search-snippet-background: #080c14;
              --search-snippet-surface: #0f172a;
              --search-snippet-text-color: #f3f4f6;
              --search-snippet-border-color: #1e293b;
              height: calc(100vh - 85px);
              width: 100%;
          }
      </style>
  </head>
  <body>
      <div class="header">
          <div>
              <h1 style="margin:0; font-size:19px; font-weight:600; color:#ffffff;">Astra Predictive Engine Desk</h1>
              <span style="font-size:12px; color:#94a3b8;">Simulating short-term strategy optimization streams</span>
          </div>
          <div class="status">Root Git Access Active</div>
      </div>

      <!-- Passes data commands through your secure interceptor wrapper path -->
      <chat-page-snippet 
          api-url="${origin}/chat"
          placeholder="Command Astra to analyze raw short patterns or execute live repository patches..."
          theme="dark">
      </chat-page-snippet>
  </body>
  </html>
  `;
}

