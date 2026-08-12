import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AdapterRegistry } from '@nicktcode/swissgroceries-mcp/dist/adapters/registry.js';
import { CoopAdapter } from '@nicktcode/swissgroceries-mcp/dist/adapters/coop/index.js';
import { searchProductsHandler } from '@nicktcode/swissgroceries-mcp/dist/tools/search_products.js';
import { getProductHandler } from '@nicktcode/swissgroceries-mcp/dist/tools/get_product.js';
import { getPromotionsHandler } from '@nicktcode/swissgroceries-mcp/dist/tools/get_promotions.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const resolveIngredientSchema = z.object({
  query: z.string().trim().min(1).describe(
    'Ingredient or grocery item to resolve, in German, French, Italian, or English.',
  ),
  limit: z.number().int().min(1).max(20).default(10).describe(
    'Maximum number of Coop candidates to return. Defaults to 10.',
  ),
  maxPrice: z.number().positive().optional().describe(
    'Optional maximum current price in CHF.',
  ),
});

const getProductSchema = z.object({
  productNumber: z.string().trim().min(1).describe(
    'Coop product number returned by resolve_ingredient_to_coop_products.',
  ),
});

const currentDiscountsSchema = z.object({
  query: z.string().trim().min(1).optional().describe(
    'Optional product keyword, such as "Käse" or "pasta". Omit for a general list.',
  ),
  endingWithinDays: z.number().int().min(1).max(60).optional().describe(
    'Only include discounts ending within this many days.',
  ),
  limit: z.number().int().min(1).max(100).default(50).describe(
    'Maximum number of current discounts to return. Defaults to 50.',
  ),
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const tools = [
  {
    name: 'resolve_ingredient_to_coop_products',
    description: [
      'Resolve an ingredient or grocery-list item to current Coop products.',
      'Returns ranked candidates with the Coop product number, current price, size, and a Coop URL.',
      'Use this first when converting a recipe ingredient or shopping-list entry into a Coop product.',
    ].join(' '),
    schema: resolveIngredientSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: 'get_coop_product',
    description: [
      'Get current details for one Coop product number.',
      'Returns its Coop URL, price, size, unit price, promotion data, tags, and nutrition when available.',
      'Use after resolve_ingredient_to_coop_products when a specific candidate needs verification.',
    ].join(' '),
    schema: getProductSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: 'find_current_coop_discounts',
    description: [
      'Find current Coop discounts, optionally filtered by a product keyword or expiry window.',
      'Returns Coop product numbers, Coop URLs, current and regular prices, and validity dates when available.',
    ].join(' '),
    schema: currentDiscountsSchema,
    annotations: readOnlyAnnotations,
  },
];

function createRegistry() {
  const registry = new AdapterRegistry();
  registry.register(new CoopAdapter());
  return registry;
}

function fallbackCoopUrl(productNumber) {
  return `https://www.coop.ch/de/search/?text=${encodeURIComponent(productNumber)}`;
}

function canonicalCoopUrl(product) {
  if (product?.productUrl) return product.productUrl;

  const productNumber = String(product?.id ?? product?.productId ?? '');
  const raw = product?.raw;
  const categoryPath = raw?.categoryPathForTracking;
  if (productNumber && typeof categoryPath === 'string' && categoryPath.trim()) {
    const cleanPath = categoryPath.replace(/^\/+|\/+$/g, '');
    return `https://www.coop.ch/de/${cleanPath}/p/${productNumber}`;
  }
  return productNumber ? fallbackCoopUrl(productNumber) : undefined;
}

function discountPercent(current, regular) {
  if (!(current >= 0) || !(regular > current)) return undefined;
  return Math.round((1 - current / regular) * 100);
}

function cleanProduct(product, includeDetails = false) {
  if (!product) return null;
  const cleaned = {
    productNumber: product.id,
    name: product.name,
    brand: product.brand,
    size: product.size,
    price: product.price,
    discountPercent: discountPercent(product.price?.current, product.price?.regular),
    unitPrice: product.unitPrice,
    tags: product.tags,
    imageUrl: product.imageUrl,
    coopUrl: canonicalCoopUrl(product),
    promotion: product.promotion,
  };

  if (includeDetails) {
    cleaned.department = product.department;
    cleaned.category = product.category;
    cleaned.availability = product.availability;
    cleaned.nutrition = product.nutrition;
  }
  return Object.fromEntries(Object.entries(cleaned).filter(([, value]) => value !== undefined));
}

function cleanPromotion(promotion) {
  const productNumber = promotion.productId;
  const current = promotion.price?.current;
  const regular = promotion.price?.regular;
  const cleaned = {
    productNumber,
    name: promotion.productName,
    brand: promotion.brand,
    size: promotion.size,
    price: promotion.price,
    discountPercent: discountPercent(current, regular),
    unitPrice: promotion.unitPrice,
    imageUrl: promotion.imageUrl,
    coopUrl: promotion.productUrl ?? (productNumber ? fallbackCoopUrl(productNumber) : undefined),
    validFrom: promotion.validFrom,
    validUntil: promotion.validUntil,
    description: promotion.description,
  };
  return Object.fromEntries(Object.entries(cleaned).filter(([, value]) => value !== undefined));
}

async function runTool(registry, name, unparsedArguments) {
  if (name === 'resolve_ingredient_to_coop_products') {
    const input = resolveIngredientSchema.parse(unparsedArguments ?? {});
    const result = await searchProductsHandler(registry, {
      query: input.query,
      chains: ['coop'],
      limit: input.limit,
      filters: input.maxPrice ? { maxPrice: input.maxPrice } : undefined,
    });
    return {
      query: input.query,
      products: (result.byChain.coop ?? []).map((product) => cleanProduct(product)),
      source: result.sources?.coop,
      errors: result.errors,
    };
  }

  if (name === 'get_coop_product') {
    const input = getProductSchema.parse(unparsedArguments ?? {});
    const result = await getProductHandler(registry, {
      chain: 'coop',
      id: input.productNumber,
    });
    return {
      product: cleanProduct(result.product, true),
      fetchedAt: result.fetchedAt,
      fromCache: result.fromCache,
    };
  }

  if (name === 'find_current_coop_discounts') {
    const input = currentDiscountsSchema.parse(unparsedArguments ?? {});
    const result = await getPromotionsHandler(registry, {
      chains: ['coop'],
      query: input.query,
      endingWithinDays: input.endingWithinDays,
    });
    return {
      query: input.query,
      discounts: result.slice(0, input.limit).map(cleanPromotion),
      returned: Math.min(result.length, input.limit),
      availableBeforeLimit: result.length,
      fetchedAt: new Date().toISOString(),
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

export function createCoopServer(registry = createRegistry()) {
  const server = new Server(
    { name: 'swiss-groceries-coop', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        'Use this server only for current Coop Switzerland product data.',
        'Resolve ingredients with resolve_ingredient_to_coop_products, then use get_coop_product only when more detail is needed.',
        'Use find_current_coop_discounts for current promotions. Treat productNumber as Coop’s product number and coopUrl as the user-facing link.',
        'All tools are read-only and use unofficial public Coop endpoints, which may occasionally be unavailable.',
      ].join(' '),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.schema),
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await runTool(registry, request.params.name, request.params.arguments);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'coop_request_failed', message }, null, 2),
        }],
      };
    }
  });

  return server;
}

export const toolDefinitions = tools;
