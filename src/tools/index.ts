import type Anthropic from '@anthropic-ai/sdk';
import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { inventoryAdd, inventoryUpdate, inventoryQuery, inventoryClearAll, producePhoto } from './inventory.js';
import { orderCreate, orderUpdate, orderQuery } from './orders.js';
import { marketQuery } from './markets.js';
import { notifyMarkets } from './notifications.js';
import { recurringOrderCreate, recurringOrderUpdate } from './recurring.js';
import { analyticsSummary } from './analytics.js';
import { userSignup } from './signup.js';
import { deliveryScheduleSet, deliveryQuery } from './delivery.js';
import { feedbackSubmit, feedbackQuery, feedbackUpdate } from './feedback.js';
import { reminderSet, reminderList, reminderUpdate } from './reminders.js';
import { emailSend } from './email.js';
import { generateViewLink } from '../utils/view-link.js';
import { directorySearch, connectionRequest, connectionRespond, pendingConnections } from './connections.js';

export interface ToolContext {
  db: Firestore;
  env: Env;
  userId?: string;
  phone: string;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'user_signup',
    description:
      'Register a new user via SMS. Creates user account, and optionally a farm (for farmers) and/or market (for market buyers). "Market" includes any food buyer: restaurants, grocery stores, food hubs, food pantries, food banks, co-ops, schools, etc. Call this when a new/unregistered phone number wants to sign up.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: "User's full name" },
        role: {
          type: 'string',
          enum: ['farmer', 'market', 'both'],
          description: 'User role: farmer (sells/grows produce), market (any entity that buys or receives produce — restaurant, grocery, food bank, food hub, co-op, etc.), or both',
        },
        location: { type: 'string', description: 'City/region (e.g., "Austin, TX")' },
        farm_name: { type: 'string', description: "Farm name (defaults to \"<name>'s Farm\" if omitted)" },
        market_name: { type: 'string', description: "Business/organization name (defaults to \"<name>'s Market\" if omitted)" },
        market_type: {
          type: 'string',
          enum: ['grocery', 'restaurant', 'co-op', 'farmers_market', 'food_hub', 'food_bank', 'food_pantry', 'school', 'other'],
          description: 'Type of market/organization (defaults to grocery)',
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
    name: 'produce_photo',
    description:
      "Attach a photo to a produce/inventory item. After inventory_add, offer the farmer three choices and call this with the chosen mode: 'existing' (reuse the saved photo for that product — only offer if product_image_on_file was true), 'generate' (create one automatically with AI), or 'upload' (returns a web link to text the farmer so they can upload their own). Use the inventory_id returned by inventory_add.",
    input_schema: {
      type: 'object' as const,
      properties: {
        inventory_id: { type: 'string', description: 'The inventory_id returned by inventory_add' },
        mode: {
          type: 'string',
          enum: ['existing', 'generate', 'upload'],
          description: "Photo source: 'existing' reuses the saved product photo, 'generate' makes one with AI, 'upload' returns a web link for the farmer to upload one",
        },
      },
      required: ['inventory_id', 'mode'],
    },
  },
  {
    name: 'inventory_clear_all',
    description: 'Clear all active inventory for the farm at once — sets every available/partial item to quantity 0 and status "sold". Use when the farmer reports spoilage, a bad harvest, or wants to wipe all listings in one go.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'inventory_update',
    description: 'Update an existing inventory listing (price, quantity, status). Also use this to clear a single item due to spoilage or selling out — set remaining to 0 and status to "sold". To find the inventory_id, call inventory_query first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        inventory_id: { type: 'string', description: 'UUID of the inventory record' },
        remaining: { type: 'number', description: 'Updated remaining quantity (use 0 to clear/zero out an item)' },
        price: { type: 'number', description: 'Updated price per unit' },
        status: {
          type: 'string',
          enum: ['available', 'partial', 'reserved', 'sold'],
          description: 'Updated status (use "sold" to mark as cleared/sold out)',
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
      'Create a new order from a market to a farm. All orders flow through the FarmLink Depot — farmers drop off, markets pick up. Provide the market, farm, and list of items with quantities.',
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
      'Set up or update a farm\'s drop-off schedule at the FarmLink Depot. Define which days and time windows the farm drops off orders.',
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
                description: 'Time window for drop-off at the depot (e.g., "6am-10am", "2pm-5pm")',
              },
            },
            required: ['day', 'time_window'],
          },
          description: 'Drop-off schedule slots',
        },
      },
      required: ['schedule'],
    },
  },
  {
    name: 'delivery_query',
    description:
      'Query upcoming drop-offs and pickups at the FarmLink Depot. Shows pending, confirmed, and in-transit orders with delivery details. For farmers: shows when to drop off at the depot. For markets: shows when orders are ready for pickup.',
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
  {
    name: 'directory_search',
    description: 'Search the FarmLink directory of all farms or markets. Use when a user wants to browse, discover, or find farms/markets to connect with.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['farms', 'markets'], description: 'Whether to search farms or markets' },
        search: { type: 'string', description: 'Optional search term (name, location, specialty)' },
      },
      required: ['type'],
    },
  },
  {
    name: 'connection_request',
    description: 'Send a connection request from a farm to a market (or vice versa). Either side can initiate. Works even if a previous request was declined — allows re-requesting. The other party is notified by SMS.',
    input_schema: {
      type: 'object' as const,
      properties: {
        farm_id: { type: 'string', description: 'Farm UUID' },
        market_id: { type: 'string', description: 'Market UUID' },
        message: { type: 'string', description: 'Optional personal note to include with the request (max 280 chars)' },
      },
      required: ['farm_id', 'market_id'],
    },
  },
  {
    name: 'connection_respond',
    description: 'Accept or decline a pending connection request. Use when a user replies YES/NO to a connection request SMS.',
    input_schema: {
      type: 'object' as const,
      properties: {
        rel_id: { type: 'string', description: 'The farm_market_rel UUID from the pending request' },
        accept: { type: 'boolean', description: 'true to accept, false to decline' },
      },
      required: ['rel_id', 'accept'],
    },
  },
  {
    name: 'pending_connections',
    description: 'List all pending connection requests for the current user (as farmer, market, or both).',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'view_link',
    description:
      'Generate a secure web link for the user to view detailed data (inventory, orders, deliveries, markets, analytics) on the FarmLink web dashboard. Use this instead of listing lengthy data over SMS — send the link so they can review it in their browser. The link auto-logs them in and opens the correct tab.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tab: {
          type: 'string',
          enum: ['inventory', 'orders', 'deliveries', 'markets', 'analytics', 'recurring'],
          description: 'Which dashboard tab to open',
        },
      },
      required: ['tab'],
    },
  },
  {
    name: 'email_send',
    description:
      'Send an email report or document to the user. Use when they ask to email their inventory, orders, invoice, or a daily/weekly summary. Supported report types: inventory, orders, invoice, custom.',
    input_schema: {
      type: 'object' as const,
      properties: {
        report_type: {
          type: 'string',
          enum: ['inventory', 'orders', 'invoice', 'custom'],
          description: 'Type of report to send',
        },
        period: {
          type: 'string',
          enum: ['day', 'week'],
          description: 'For orders reports: day = today, week = this week (default: week)',
        },
        order_id: { type: 'string', description: 'Order UUID — required for invoice reports' },
        to_email: { type: 'string', description: "Override recipient email (default: user's email on file)" },
        subject: { type: 'string', description: 'Subject line — required for custom emails' },
        message: { type: 'string', description: 'Body text — required for custom emails' },
      },
      required: ['report_type'],
    },
  },
  {
    name: 'feedback_submit',
    description:
      'Submit a feature request or bug report from a user. Use when a user says they want to request a feature, suggest an improvement, report a bug or issue, or provide feedback about the platform.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['feature_request', 'bug_report'],
          description: 'Whether this is a feature request or a bug report',
        },
        title: {
          type: 'string',
          description: 'Short summary/title of the feedback (max 255 chars)',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the feature request or bug, including any steps to reproduce for bugs',
        },
      },
      required: ['type', 'title', 'description'],
    },
  },
  {
    name: 'feedback_query',
    description:
      'List and filter feedback items (feature requests and bug reports). Admins see all feedback; regular users see only their own. Use when someone asks to see feedback, check on their requests, or review submitted issues.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['feature_request', 'bug_report'],
          description: 'Filter by feedback type',
        },
        status: {
          type: 'string',
          enum: ['open', 'under_review', 'planned', 'in_progress', 'resolved', 'closed'],
          description: 'Filter by status',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Filter by priority',
        },
      },
    },
  },
  {
    name: 'feedback_update',
    description:
      'Update a feedback item\'s status, priority, or admin notes. Admin only. Use when an admin wants to triage, review, or update the status of a feedback item.',
    input_schema: {
      type: 'object' as const,
      properties: {
        feedback_id: { type: 'string', description: 'UUID of the feedback item to update' },
        status: {
          type: 'string',
          enum: ['open', 'under_review', 'planned', 'in_progress', 'resolved', 'closed'],
          description: 'New status',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'New priority level',
        },
        admin_notes: {
          type: 'string',
          description: 'Internal admin notes about this feedback item',
        },
      },
      required: ['feedback_id'],
    },
  },
  {
    name: 'reminder_set',
    description:
      'Set a recurring reminder for the user, delivered by text/push at the chosen time (Central time). Use when a user asks to be reminded about something on a schedule, e.g. "remind me every Monday at 8am to update my inventory".',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'What to remind the user about (e.g., "Update inventory for the weekend market")' },
        frequency: { type: 'string', enum: ['daily', 'weekly'], description: 'How often the reminder repeats' },
        schedule_days: { type: 'string', description: 'For weekly reminders: day name(s), e.g. "Monday" or "Tue, Fri"' },
        time: { type: 'string', description: 'Time of day, e.g. "8am", "2:30 PM", or "14:00" (Central time)' },
      },
      required: ['title', 'frequency', 'time'],
    },
  },
  {
    name: 'reminder_list',
    description:
      "List the user's reminders. Use when they ask what reminders they have set.",
    input_schema: {
      type: 'object' as const,
      properties: {
        include_paused: { type: 'boolean', description: 'Include paused reminders (default false)' },
      },
      required: [],
    },
  },
  {
    name: 'reminder_update',
    description:
      'Update, pause, resume, or delete one of the user\'s reminders. Use reminder_list first to find the reminder_id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reminder_id: { type: 'string', description: 'UUID of the reminder' },
        title: { type: 'string', description: 'New reminder text' },
        frequency: { type: 'string', enum: ['daily', 'weekly'], description: 'New frequency' },
        schedule_days: { type: 'string', description: 'New day(s) for weekly reminders' },
        time: { type: 'string', description: 'New time of day (e.g. "8am", "14:00")' },
        active: { type: 'boolean', description: 'false to pause, true to resume' },
        delete: { type: 'boolean', description: 'true to permanently delete the reminder' },
      },
      required: ['reminder_id'],
    },
  },
];

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  user_signup: userSignup,
  inventory_add: inventoryAdd,
  inventory_update: inventoryUpdate,
  inventory_query: inventoryQuery,
  inventory_clear_all: inventoryClearAll,
  produce_photo: producePhoto,
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
  directory_search: directorySearch,
  connection_request: connectionRequest,
  connection_respond: connectionRespond,
  pending_connections: pendingConnections,
  view_link: async (input: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.userId) return { error: 'No user found for this session.' };
    const userDoc = await ctx.db.collection('users').doc(ctx.userId).get();
    if (!userDoc.exists) return { error: 'No user found for this session.' };
    const user = userDoc.data()!;
    const url = await generateViewLink({
      env: ctx.env,
      userId: ctx.userId,
      role: user.role,
      tab: input.tab as import('../utils/view-link.js').ViewTab,
    });
    return { url };
  },
  email_send: emailSend,
  feedback_submit: feedbackSubmit,
  feedback_query: feedbackQuery,
  feedback_update: feedbackUpdate,
  reminder_set: reminderSet,
  reminder_list: reminderList,
  reminder_update: reminderUpdate,
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
