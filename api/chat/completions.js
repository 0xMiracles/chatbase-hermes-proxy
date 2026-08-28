export default async function handler(req, res) {
  try {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        error: {
          message: "Method not allowed",
          type: "method_error"
        }
      });
    }

    const CHATBASE_API_KEY = process.env.CHATBASE_API_KEY;
    const CHATBASE_AGENT_ID = process.env.CHATBASE_AGENT_ID;
    const PROXY_API_KEY = process.env.PROXY_API_KEY;

    if (!CHATBASE_API_KEY) {
      console.error("Missing env: CHATBASE_API_KEY");
      return res.status(500).json({
        error: {
          message: "Missing CHATBASE_API_KEY",
          type: "server_error"
        }
      });
    }

    if (!CHATBASE_AGENT_ID) {
      console.error("Missing env: CHATBASE_AGENT_ID");
      return res.status(500).json({
        error: {
          message: "Missing CHATBASE_AGENT_ID",
          type: "server_error"
        }
      });
    }

    if (!PROXY_API_KEY) {
      console.error("Missing env: PROXY_API_KEY");
      return res.status(500).json({
        error: {
          message: "Missing PROXY_API_KEY",
          type: "server_error"
        }
      });
    }

    const authHeader = req.headers.authorization || "";
    const incomingKey = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (incomingKey !== PROXY_API_KEY) {
      console.error("Invalid proxy API key");
      return res.status(401).json({
        error: {
          message: "Invalid proxy API key",
          type: "authentication_error"
        }
      });
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const wantsStream = body.stream === true;

    if (!messages.length) {
      console.error("No messages provided");
      return res.status(400).json({
        error: {
          message: "No messages provided",
          type: "invalid_request_error"
        }
      });
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");

    if (!lastUserMessage) {
      console.error("No user message found");
      return res.status(400).json({
        error: {
          message: "No user message found",
          type: "invalid_request_error"
        }
      });
    }

    const messageText = extractText(lastUserMessage.content);

    if (!messageText) {
      console.error("No message content found");
      return res.status(400).json({
        error: {
          message: "No message content found",
          type: "invalid_request_error"
        }
      });
    }

    const userId =
      body.user ||
      body.userId ||
      "hermes-user";

    const chatbaseUrl = `https://www.chatbase.co/api/v2/agents/${CHATBASE_AGENT_ID}/chat`;

    console.log("Calling Chatbase API", {
      url: chatbaseUrl,
      hasApiKey: Boolean(CHATBASE_API_KEY),
      agentId: CHATBASE_AGENT_ID,
      userId,
      wantsStream
    });

    const chatbaseResponse = await fetch(chatbaseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CHATBASE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: messageText,
        stream: false,
        userId
      })

    });

    const rawText = await chatbaseResponse.text();

    if (!chatbaseResponse.ok) {
      console.error("Chatbase API error", {
        status: chatbaseResponse.status,
        response: rawText
      });

      return res.status(500).json({
        error: {
          message: "Chatbase API request failed",
          type: "upstream_error",
          status: chatbaseResponse.status,
          details: rawText
        }
      });
    }

    let chatbaseData;
    try {
      chatbaseData = JSON.parse(rawText);
    } catch (error) {
      console.error("Failed to parse Chatbase response", {
        rawText
      });

      return res.status(500).json({
        error: {
          message: "Failed to parse Chatbase response",
          type: "parse_error",
          details: rawText
        }
      });
    }

    const answer =
      chatbaseData.text ||
      chatbaseData.message ||
      chatbaseData.response ||
      chatbaseData.answer ||
      chatbaseData.data?.text ||
      chatbaseData.data?.message ||
      chatbaseData.data?.response ||
      "";

    if (!answer) {
      console.error("Empty answer from Chatbase", {
        chatbaseData
      });

      return res.status(500).json({
        error: {
          message: "Empty answer from Chatbase",
          type: "upstream_error",
          details: chatbaseData
        }
      });
    }

    const id = `chatcmpl_${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || "chatbase";

    // Если Hermes запросил stream=true, отдаём OpenAI-compatible SSE.
    if (wantsStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });

      const firstChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: answer
            },
            finish_reason: null
          }
        ]
      };

      const finalChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop"
          }
        ]
      };

      res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // Обычный non-streaming OpenAI-compatible ответ.
    return res.status(200).json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: answer
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });
  } catch (error) {
    console.error("Unhandled proxy error", {
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      error: {
        message: "Unhandled proxy error",
        type: "server_error"
      }
    });
  }
}

function extractText(content) {
  if (!content) return "";

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part.type === "text") return part.text || "";
        if (part.text) return part.text;
        return "";
      })
      .join("\n")
      .trim();
  }

  if (typeof content === "object") {
    return content.text || "";
  }

  return "";
}
