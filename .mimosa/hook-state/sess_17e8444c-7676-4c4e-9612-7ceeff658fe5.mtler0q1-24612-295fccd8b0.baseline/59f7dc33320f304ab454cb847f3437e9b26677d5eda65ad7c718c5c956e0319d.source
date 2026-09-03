export function notFound(req, res) {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error("[error]", err);
  const status = err.status ?? 500;
  res.status(status).json({
    error: err.expose ? err.message : "Internal server error",
  });
}
