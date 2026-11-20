# Swiss Groceries MCP — Cloud Run

A stateless Streamable HTTP service at /mcp with three Coop tools and a
shared product search for Coop and Migros. The legacy Coop tools use the
upstream [swissgroceries-mcp package](https://github.com/nicktcode/swissgroceries-mcp).

## Tools

| Tool | Purpose |
|---|---|
| `resolve_ingredient_to_coop_products` | Search Coop and return candidate products, product numbers, prices, and URLs. |
| `get_coop_product` | Retrieve current details for one Coop product number. |
| `find_current_coop_discounts` | Find current Coop promotions, optionally filtered by keyword or expiry. |
| `search_retailer_products` | Find current products from either Coop or Migros using the shared lookup format. |

All tools are annotated as read-only. The upstream retailer endpoints can become unavailable.

`search_retailer_products` searches one retailer per call using `retailer`
(`coop` or `migros`), `query` (1–120 characters), and `limit` (1–10).
Its MCP text content contains JSON with `products`, `errors`, and an ISO
`fetchedAt` timestamp. Missing prices are null. A completed search can return
no matches, a retailer error, or usable matches alongside an error for
incomplete upstream data. The previous Coop tools keep their original contracts.

Search uses German results. Migros requests use the configured
`SWISSGROCERIES_MIGROS_REGION_ID` or region `2` (Zürich) by default. Migros
`productId` is the public catalogue number and `detailId` is the provider UID.
The service shares a guest session and a two-minute result cache within each
process. Each retailer allows four simultaneous lookups and refills the
initial burst of four at two lookups per second. A lookup has a 3.5-second
deadline. This tool uses the public catalogue and guest routes and returns an
unavailable error if access is denied.

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
