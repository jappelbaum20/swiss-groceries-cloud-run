# Swiss Groceries Coop MCP — Cloud Run

A small Streamable HTTP wrapper around
[`@nicktcode/swissgroceries-mcp`](https://github.com/nicktcode/swissgroceries-mcp),
focused on the three read-only Coop workflows needed by ChatGPT:

1. Resolve an ingredient or grocery-list entry to current Coop products.
2. Return the Coop product number and a user-facing Coop URL.
3. Find current Coop discounts.

The upstream project is a stdio MCP server. This wrapper exposes its Coop
adapter as a stateless Streamable HTTP MCP endpoint at `/mcp`, which makes it
suitable for Google Cloud Run and avoids a desktop tunnel.

## Tools

| Tool | Purpose |
|---|---|
| `resolve_ingredient_to_coop_products` | Search Coop and return candidate products, product numbers, prices, and URLs. |
| `get_coop_product` | Retrieve current details for one Coop product number. |
| `find_current_coop_discounts` | Find current Coop promotions, optionally filtered by keyword or expiry. |

All tools are explicitly annotated as read-only. Data comes from unofficial,
public Coop endpoints through the upstream package and can change or become
temporarily unavailable.

## Run locally

Requires Node.js 20 or newer.

```bash
npm ci
npm test
npm start
```

The health check is at `http://localhost:8080/healthz` and the MCP endpoint is
`http://localhost:8080/mcp`.

## Deploy to Google Cloud Run

This repository includes a production Dockerfile. Deploy it as a Cloud Run web
service from the GitHub repository, allow unauthenticated access so ChatGPT can
reach the endpoint, and keep the maximum instance count low to control cost.

After deployment, connect ChatGPT to:

```text
https://YOUR-CLOUD-RUN-URL/mcp
```

The endpoint intentionally uses no authentication because current ChatGPT
developer-mode MCP connections support OAuth, no authentication, or mixed
authentication—not arbitrary shared-secret headers. The tools are read-only,
contain no private data, and require no retailer credentials. Cloud Run cost
controls and monitoring should still be configured because the HTTPS endpoint
is public.

## License and attribution

This wrapper is licensed under AGPL-3.0-only. It depends on and communicates
with [`@nicktcode/swissgroceries-mcp`](https://github.com/nicktcode/swissgroceries-mcp),
also licensed under AGPL-3.0-only. This project is not affiliated with or
endorsed by Coop.
