function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

function sanitizeUserId(value) {
  const raw = String(value || "hermes_user");
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "hermes_user";
}

function contentToText(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        if (part?.text) return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    return content.text || JSON.stringify(content);
  }

  return "";
}

function buildChatbaseMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const cleaned = messages
    .map((m) => {
      const role = m.role || "user";
      const text = contentToText(m.content).trim();
      if (!text) return null;
      return `${role}: ${text}`;
    })
    .filter(Boolean);

  if (cleaned.length === 0) return "";

  return [
    "Ниже история диалога из Hermes.",
    "Ответь на последнее сообщение пользователя, учитывая контекст.",
    "",
    cleaned.join("\n")
  ].join("\n");
}

function extractAnswer(chatbaseData) {
  const parts = chatbaseData?.data?.parts || [];

  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  if (text) return text;

  const toolCall = parts.find((p) => p.type === "tool-call");
  if (toolCall) {
    return "Агент запросил выполнение действия, но этот proxy пока поддерживает только текстовые ответы.";
  }

  return "";
}

function sendOpenAIJson(res, { id, model, answer, finishReason }) {
  return res.status(200).json({
    id: id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "chatbase",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: answer || ""
        },
        finish_reason: finishReason || "stop"
      }
    ]
  });
}

function sendOpenAIStream(res, { id, model, answer }) {
  const responseId = id || `chatcmpl_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const usedModel = model || "chatbase";

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });

  res.write(
    `data: ${JSON.stringify({
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: usedModel,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant"
          },
          finish_reason: null
        }
      ]
    })}\n\n`
  );

  res.write(
    `data: ${JSON.stringify({
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: usedModel,
      choices: [
        {
          index: 0,
          delta: {
            content: answer || ""
          },
          finish_reason: null
        }
      ]
    })}\n\n`
  );

  res.write(
    `data: ${JSON.stringify({
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: usedModel,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ]
    })}\n\n`
  );

  res.write("data: [DONE]\n\n");
  res.end();
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: {
        message: "Method not allowed"
      }
    });
  }

  try {
    const proxyKey = process.env.PROXY_API_KEY;

    if (proxyKey) {
      const providedKey = getBearerToken(req);

      if (providedKey !== proxyKey) {
        return res.status(401).json({
          error: {
            message: "Invalid proxy API key",
            type: "authentication_error"
          }
        });
      }
    }

    const chatbaseApiKey = process.env.CHATBASE_API_KEY;
    const chatbaseAgentId = process.env.CHATBASE_AGENT_ID;

    if (!chatbaseApiKey || !chatbaseAgentId) {
      return res.status(500).json({
        error: {
          message: "Proxy is not configured. Missing CHATBASE_API_KEY or CHATBASE_AGENT_ID."
        }
      });
    }

    const body = req.body || {};
    const messages = body.messages || [];
    const model = body.model || "chatbase";
    const wantsStream = body.stream === true;

    const message = buildChatbaseMessage(messages);

    if (!message) {
      return res.status(400).json({
        error: {
          message: "No message content found"
        }
      });
    }

    const userId = sanitizeUserId(
      body.user ||
      body.userId ||
      req.headers["x-user-id"] ||
      "hermes_user"
    );

    const chatbaseResponse = await fetch(
      `https://www.chatbase.co/api/v2/agents/${chatbaseAgentId}/chat`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${chatbaseApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message,
          stream: false,
          userId
        })
      }
    );

    const chatbaseData = await chatbaseResponse.json().catch(() => null);

    if (!chatbaseResponse.ok) {
      return res.status(chatbaseResponse.status).json({
        error: {
          message:
            chatbaseData?.error?.message ||
            "Chatbase API request failed",
          code: chatbaseData?.error?.code || "CHATBASE_API_ERROR"
        }
      });
    }

    const answer = extractAnswer(chatbaseData);
    const messageId = chatbaseData?.data?.id;
    const finishReason =
      chatbaseData?.data?.metadata?.finishReason === "tool-calls"
        ? "tool_calls"
        : "stop";

    if (wantsStream) {
      return sendOpenAIStream(res, {
        id: messageId,
        model,
        answer
      });
    }

    return sendOpenAIJson(res, {
      id: messageId,
      model,
      answer,
      finishReason
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        message: "Proxy error"
      }
    });
  }
}
