"use strict";

const CLIENT_ONLY_ORIGINS = new Set([
  "https://portal.ledgetop.app", "https://portal.ledgetopdroneservices.com",
  "https://portal.ledgetoptechnologies.com", "https://client.ledgetopdroneservices.com",
]);

function exactControllerOrigin(value, allowLoopback = false) {
  if (typeof value !== "string" || CLIENT_ONLY_ORIGINS.has(value)) return null;
  try {
    const url = new URL(value);
    const loopback = allowLoopback && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.origin === value && !url.hostname.includes("*")
      && (url.protocol === "https:" && (!url.port || loopback)
        || loopback && url.protocol === "http:") ? value : null;
  } catch { return null; }
}

// Invalid lists fail closed as a whole. Portal/embed origins are configured
// separately and do not become staff controllers through that permission.
function controllerOrigins(primary, configured, allowLoopback = false) {
  const values = configured === undefined ? [primary]
    : String(configured).split(",").map(value => value.trim());
  if (!values.length || values.length > 4 || new Set(values).size !== values.length
    || !values.every(value => exactControllerOrigin(value, allowLoopback)) || !values.includes(primary)) return [];
  return values;
}

function controllerOriginAllowed(origin, allowed, allowLoopback = false) {
  return Boolean(exactControllerOrigin(origin, allowLoopback) && allowed.includes(origin));
}
module.exports = { exactControllerOrigin, controllerOrigins, controllerOriginAllowed };
