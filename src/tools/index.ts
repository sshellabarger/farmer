import type Anthropic from '@anthropic-ai/sdk';
import type { Kysely } from 'kysely';
import type { DB } from '../types/schema.js';
import type { Env } from '../config/env.js';
import { inventoryAdd, inventoryUpdate, inventoryQuery } from './inventory.js';
import { orderCreate, orderUpdate, orderQuery } from './orders.js';
import { marketQuery } from './markets.js';
import { notifyMarkets } from './notifications.js';
import { recurringOrderCreate, recurringOrderUpdate } from './recurring.js';
import { analyticsSummary } from './analytics.js';
import { userSignup } from './signup.js';
import { deliveryScheduleSet, deliveryQuery } from './delivery.js';

export interface ToolContext {
  db: Kysely<DB>;
  env: Env;
  userId?: string;
  phone: string;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'user_signup',
    description:
      'Register a new user via SMS. Creates user account, and optionally a farm (for farmers) and/or market (for market buyers). Call this when a new/unregistered phone number wants to sign up.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: "User's full name" },
        role: {
          type: 'string',
          enum: ['farmer', 'market', 'both'],
          description: 'User role: farmer (sells produce), market (buys produce), or both',
        },
        location: { type: 'string', description: 'City/region (e.g., "Austin, TX")' },
        farm_name: { type: 'string', description: "Farm name (defaults to \"<name>'s Farm\" if omitted)" },
        market_name: { type: 'string', description: "Market/business name (defaults to \"<name>'s Market\" if omitted)" },
        market_type: {
          type: 'string',
          enum: ['grocery', 'restaurant', 'co-op', 'farmers_market'],
          description: 'Type of market (defaults to grocery)',
        },
        specialty: { type: 'string', description: 'Farm specialty (e.g., "organic vegetables")' },
      },
      required: ['name', 'role', 'location'],
    },
  },
  {
    name: 'inventory_add',
    description:
      'Add a new inventory listing for a farm product. Creates the product if it does not exist. Returns the new inventory record.',
    input_schema: {
      type: 'object' as const,
      properties: {
        product: { type: 'string', description: 'Product name (e.g., "Cherokee Purple Tomatoes")' },
        quantity: { type: 'number', description: 'Quantity available' },
        unit: { type: 'string', description: 'Unit of measure (lb, bunch, pint, dozen, etc.)' },
        price: { type: 'number', description: 'Price per unit in dollars' },
        category: { type: 'string', description: 'Product category (Vegetables, Fruits, Herbs, etc.)' },
        harvest_date: { type: 'string', description: 'Harvest date in YYYY-MM-DD format' },
      },
      required: ['product', 'quantity', 'unit'],
    },
  },
  {
    name: 'inventory_update',
    description: 'Update an existing inventory listing (price, quantity, status).',
    input_schema: {
      type: 'object' as const,
      properties: {
        inventory_id: { type: 'string', description: 'UUID of the inventory record' },
        remaining: { type: 'number', description: 'Updated remaining quantity' },
        price: { type: 'number', description: 'Updated price per unit' },
        status: {
          type: 'string',
          enum: ['available', 'partial', 'reserved', 'sold'],
          description: 'Updated status',
        },
      },
      required: ['inventory_id'],
    },
  },
  {
    name: 'inventory_query',
    description: 'Search and list inventory. Can filter by farm, category, status, or product name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        farm_id: { type: 'string', description: 'Filter by farm UUID' },
        category: { type: 'string', description: 'Filter by product category' },
        status: { type: 'string', description: 'Filter by inventory status' },
        search: { type: 'string', description: 'Search product name' },
      },
    },
  },
  {
    name: 'order_create',
    description:
      'Create a new order from a market to a farm. Provide the market, farm, and list of items with quantities.',
    input_schema: {
      type: 'object' as const,
      properties: {
        farm_id: { type: 'string', description: 'Farm UUID' },
        market_id: { type: 'string', description: 'Market UUID' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              inventory_id: { type: 'string', description: 'Inventory listing UUID' },
              quantity: { type: 'number', description: 'Quantity to order' },
            },
            required: ['inventory_id', 'quantity'],
          },
          description: 'List of items to order',
        },
        delivery_type: {
          type: 'string',
          enum: ['pickup', 'delivery'],
          description: 'Whether the market will pick up or the farm will deliver. Ask the market their preference.',
        },
        notes: { type: 'string', description: 'Optional order notes' },
      },
      required: ['farm_id', 'market_id', 'items'],
    },
  },
  {
    name: 'order_update',
    description: 'Update an order status or details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        order_id: { type: 'string', description: 'Order UUID' },
        status: {
          type: 'string',
          enum: ['pending', 'confirmed', 'in_transit', 'delivered', 'cancelled'],
          description: 'New order status',
        },
        notes: { type: 'string', description: 'Updated notes' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'order_query',
    description: 'Query orders with filters (date, status, market, farm).',
    input_schema: {
      type: 'object' as const,
      properties: {
        farm_id: { type: 'string', description: 'Filter by farm' },
        market_id: { type: 'string', description: 'Filter by market' },
        status: { type: 'string', description: 'Filter by order status' },
        date: { type: 'string', description: 'Filter by date (YYYY-MM-DD)' },
      },
    },
  },
  {
    name: 'market_query',
    description: "Query markets connected to a farm, or browse available inventory as a market.",
    input_schema: {
      type: 'object' as const,
      properties: {
        farm_id: { type: 'string', description: 'Get markets connected to this farm' },
        market_id: { type: 'string', description: 'Get available inventory for this market' },
      },
    },
  },
  {
    name: 'notify_markets',
    description:
      'Send inventory notifications to connected markets. Uses priority/delay settings from farm_market_rels.',
    input_schema: {
      type: 'object' as const,
      properties: {
        inventory_id: { type: 'string', description: 'Inventory listing to notify about' },
        market_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific market UUIDs (if omitted, uses all connected markets with priority delays)',
        },
      },
      required: ['inventory_id'],
    },
  },
  {
    name: 'recurring_order_create',
    description: 'Create a new standing/recurring order between a farm and market.',
    input_schema: {
      type: 'object' as const,
      properties: {
        farm_id: { type: 'string', description: 'Farm UUID' },
        market_id: { type: 'string', description: 'Market UUID' },
        frequency: {
          type: 'string',
          enum: ['daily', 'twice_weekly', 'weekly', 'biweekly', 'monthly'],
          description: 'How often the order repeats',
        },
        days: { type: 'string', description: 'Schedule days (e.g., "mon,wed,fri" or "Monday")' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_name: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string' },
            },
            required: ['product_name', 'quantity', 'unit'],
          },
        },
      },
      required: ['frequency', 'days', 'items'],
    },
  },
  {
    name: 'recurring_order_update',
    description: 'Update a standing/recurring order (frequency, schedule, active status).',
    input_schema: {
      type: 'object' as const,
      properties: {
        recurring_id: { type: 'string', description: 'Recurring order UUID' },
        frequency: { type: 'string', description: 'New frequency' },
        schedule_days: { type: 'string', description: 'New schedule days' },
        active: { type: 'boolean', description: 'Enable or disable' },
      },
      required: ['recurring_id'],
    },
  },
  {
    name: 'delivery_schedule_set',
    description:
      'Set up or update a farm\'s delivery schedule. Define which days and time windows the farm delivers, and optionally which areas they serve.',
    input_schema: {
      type: 'object' as const,
      properties: {
        schedule: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              day: {
                type: 'string',
                enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
                description: 'Day of the week',
              },
              time_window: {
                type: 'string',
                description: 'Time window for deliveries (e.g., "6am-10am", "2pm-5pm")',
              },
              areas: {
                type: 'array',
                items: { type: 'string' },
                description: 'Areas/cities served on this day (optional)',
              },
            },
            required: ['day', 'time_window'],
          },
          description: 'Delivery schedule slots',
        },
      },
      required: ['schedule'],
    },
  },
  {
    name: 'delivery_query',
    description:
      'Query upcoming deliveries and the farm\'s delivery schedule. Shows pending, confirmed, and in-transit orders with delivery details including locations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        farm_id: { type: 'string', description: 'Filter by farm UUID' },
        market_id: { type: 'string', description: 'Filter by market UUID' },
        date: { type: 'string', description: 'Filter by date (YYYY-MM-DD), defaults to all upcoming' },
      },
    },
  },
  {
    name: 'analytics_summary',
    description: 'Get a sales analytics summary for a period (today, week, or month). Includes revenue, order count, and top products.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'week', 'month'],
          description: 'Time period for the summary',
        },
        farm_id: { type: 'string', description: 'Optional farm UUID to scope results' },
      },
    },
  },
];

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  user_signup: userSignup,
  inventory_add: inventoryAdd,
  inventory_update: inventoryUpdate,
  inventory_query: inventoryQuery,
  order_create: orderCreate,
  order_update: orderUpdate,
  order_query: orderQuery,
  market_query: marketQuery,
  notify_markets: notifyMarkets,
  recurring_order_create: recurringOrderCreate,
  recurring_order_update: recurringOrderUpdate,
  delivery_schedule_set: deliveryScheduleSet,
  delivery_query: deliveryQuery,
  analytics_summary: analyticsSummary,
};

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(input, ctx);
}
