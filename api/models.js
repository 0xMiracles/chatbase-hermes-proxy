function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

export default async function handler(req, res) {
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

  return res.status(200).json({
    object: "list",
    data: [
      {
        id: "chatbase",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "chatbase"
      }
    ]
  });
}
