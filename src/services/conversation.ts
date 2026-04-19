import Anthropic from '@anthropic-ai/sdk';
import type { Kysely } from 'kysely';
import type { DB } from '../types/schema.js';
import type { Env } from '../config/env.js';
import { toolDefinitions, executeTool, type ToolContext } from '../tools/index.js';

let anthropic: Anthropic | null = null;

function getAnthropic(apiKey: string) {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
}

const SYSTEM_PROMPT = `You are FarmLink, a smart agricultural sales assistant.
You help farmers list inventory and manage orders via text message.
You help markets discover and order from local farms.

PERSONALITY:
- Warm, efficient, proactive
- Confirm actions clearly with emoji indicators
- Suggest logical next steps
- Use structured formatting for lists (emoji bullets, line breaks)
- Keep messages concise — this is SMS, not email

PROACTIVE BEHAVIORS:
1. If farmer lists inventory without a price, ask for the price or check their price list
2. After completing an action, suggest what's logical next
3. Surface quick stats when they'd be useful context
4. When a market places an order, ask if they want pickup or delivery
5. Include the delivery day and time window in order confirmations
6. Farmers can set up their delivery schedule (e.g., "I deliver Monday and Thursday mornings")

DELIVERY SYSTEM:
- Farms have delivery schedules with specific days and time windows (e.g., Monday 6am-10am)
- When creating an order, ask the market: "Pickup or delivery?"
- If the farm has a delivery schedule, calculate the next available delivery date
- Include the delivery day, time window, and locations in order confirmations
- Use delivery_schedule_set to configure a farm's delivery days
- Use delivery_query to show upcoming deliveries

CONFIRMATION PATTERNS:
- Always confirm quantities, prices, and recipients before executing
- Use numbered options for multi-choice
- Accept shorthand (y/n, numbers, first-name references to markets)
- Include delivery details (pickup/delivery, day, time) in order confirmations

FEEDBACK SYSTEM:
- Any user can submit feature requests or bug reports via text (e.g., "I wish I could..." or "there's a problem with...")
- Use feedback_submit to record their feedback
- Users can ask to see their submitted feedback with feedback_query
- Admins can review all feedback with feedback_query, and triage with feedback_update (set status, priority, add notes)
- When an admin asks "show feedback" or "any new issues?", use feedback_query to list recent items

TOOL USE IS MANDATORY FOR ANY ACTION:
- NEVER claim you added, created, updated, deleted, scheduled, confirmed, cancelled, registered, listed, or saved anything unless you actually invoked the matching tool in this turn.
- If a user asks for an action (add inventory, place an order, update a price, change order status, set delivery schedule, sign up, submit feedback, etc.), you MUST call the corresponding tool BEFORE replying with confirmation.
- Adding inventory → inventory_add. Updating inventory → inventory_update. Creating an order → order_create. Updating an order → order_update. Setting delivery schedule → delivery_schedule_set. Signup → user_signup. Recurring orders → recurring_order_create / recurring_order_update. Feedback → feedback_submit / feedback_update.
- Only after a tool returns success may you confirm the action to the user. If a tool returns an error or needs more info, ask the user — do not pretend it succeeded.
- Reading/listing data also requires the matching query tool; do not invent data from context alone unless it is already provided in CURRENT CONTEXT.

Always respond naturally and concisely — remember this is SMS.`;

// Tool names that mutate data — used to verify Claude actually performed claimed actions.
const MUTATING_TOOLS = new Set([
  'inventory_add',
  'inventory_update',
  'order_create',
  'order_update',
  'recurring_order_create',
  'recurring_order_update',
  'delivery_schedule_set',
  'user_signup',
  'feedback_submit',
  'feedback_update',
  'notify_markets',
]);

// Past-tense action phrases that imply a mutation was performed.
// If any of these appear in the final reply but no mutating tool was called this turn,
// we force Claude to either actually call the tool or rewrite its reply.
const ACTION_CLAIM_PATTERNS: RegExp[] = [
  /\b(added|listed|posted|created|placed|submitted|recorded|saved|logged|registered|signed[- ]?up|set\s+up|set\s+your|scheduled|booked|confirmed|cancell?ed|updated|changed|removed|deleted|reserved|marked\s+as)\b/i,
  /\b(i\s+(?:have|just|now)\s+(?:added|created|updated|placed|set|scheduled|registered|cancell?ed|removed|saved|recorded))\b/i,
  /\b(your\s+(?:order|inventory|listing|delivery\s+schedule|account|feedback)\s+(?:is|has\s+been|was)\s+(?:created|added|updated|saved|placed|confirmed|set|recorded|submitted))\b/i,
  /\b(done|all\s+set|got\s+it\s+saved)\b/i,
];

function responseClaimsAction(text: string): boolean {
  return ACTION_CLAIM_PATTERNS.some((re) => re.test(text));
}

interface ProcessMessageInput {
  db: Kysely<DB>;
  env: Env;
  phone: string;
  message: string;
  messageSid: string;
}

export async function processInboundMessage(input: ProcessMessageInput): Promise<string> {
  const { db, env, phone, message } = input;

  // 1. Look up user by phone
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('phone', '=', phone)
    .executeTakeFirst();

  // 2. Get or create conversation
  let conversation = await db
    .selectFrom('conversations')
    .selectAll()
    .where('phone_number', '=', phone)
    .orderBy('last_message_at', 'desc')
    .executeTakeFirst();

  if (!conversation) {
    if (user) {
      const [newConv] = await db
        .insertInto('conversations')
        .values({ user_id: user.id, phone_number: phone, context: 'general' })
        .returningAll()
        .execute();
      conversation = newConv;
    } else {
      // Create a temporary anonymous conversation so pre-signup messages are stored
      // The user_signup tool will update this with the real user_id
      // Use a placeholder user_id — we'll need to allow nullable or use a system user
      // For now, create without user_id by using the first admin or a placeholder
      const systemUser = await db
        .selectFrom('users')
        .select('id')
        .where('role', '=', 'admin')
        .executeTakeFirst();

      if (!systemUser) {
        // Create a system user for anonymous conversations
        const [sysUser] = await db
          .insertInto('users')
          .values({ name: 'System', phone: '+10000000000', role: 'admin' })
          .onConflict((oc) => oc.column('phone').doNothing())
          .returningAll()
          .execute();

        if (sysUser) {
          const [newConv] = await db
            .insertInto('conversations')
            .values({ user_id: sysUser.id, phone_number: phone, context: 'general' })
            .returningAll()
            .execute();
          conversation = newConv;
        }
      } else {
        const [newConv] = await db
          .insertInto('conversations')
          .values({ user_id: systemUser.id, phone_number: phone, context: 'general' })
          .returningAll()
          .execute();
        conversation = newConv;
      }
    }
  }

  // 3. Store inbound message
  if (conversation) {
    await db
      .insertInto('messages')
      .values({
        conversation_id: conversation.id,
        direction: 'inbound',
        body: message,
        source: 'sms',
      })
      .execute();
  }

  // 4. Load conversation history (last 20 messages)
  const history = conversation
    ? await db
        .selectFrom('messages')
        .selectAll()
        .where('conversation_id', '=', conversation.id)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute()
    : [];

  // 5. Build context for Claude
  const contextParts: string[] = [];

  if (user) {
    contextParts.push(`USER: ${user.name} (${user.role}), phone: ${user.phone}`);

    if (user.role === 'farmer' || user.role === 'both') {
      const farm = await db
        .selectFrom('farms')
        .selectAll()
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      if (farm) {
        contextParts.push(`FARM: ${farm.name} (id: ${farm.id}), ${farm.location}, specialty: ${farm.specialty || 'general'}`);

        // Delivery schedule
        if (farm.delivery_schedule && Array.isArray(farm.delivery_schedule) && (farm.delivery_schedule as any[]).length > 0) {
          const slots = farm.delivery_schedule as Array<{ day: string; time_window: string; areas?: string[] }>;
          contextParts.push(
            `DELIVERY SCHEDULE:\n${slots.map((s) => `  - ${s.day}: ${s.time_window}${s.areas?.length ? ` (${s.areas.join(', ')})` : ''}`).join('\n')}`
          );
        } else {
          contextParts.push('DELIVERY SCHEDULE: Not set up yet. Farmer can text "I deliver on Monday mornings" to set it up.');
        }

        // Active inventory
        const inventory = await db
          .selectFrom('inventory')
          .innerJoin('products', 'products.id', 'inventory.product_id')
          .select([
            'inventory.id',
            'products.name as product_name',
            'inventory.remaining',
            'products.unit',
            'inventory.price',
            'inventory.status',
          ])
          .where('inventory.farm_id', '=', farm.id)
          .where('inventory.status', 'in', ['available', 'partial'])
          .execute();

        if (inventory.length > 0) {
          contextParts.push(
            `ACTIVE INVENTORY:\n${inventory.map((i) => `  - ${i.product_name}: ${i.remaining} ${i.unit} @ $${i.price}/${i.unit} [${i.status}] (inventory_id: ${i.id})`).join('\n')}`
          );
        }

        // Connected markets
        const markets = await db
          .selectFrom('farm_market_rels')
          .innerJoin('markets', 'markets.id', 'farm_market_rels.market_id')
          .select(['markets.id', 'markets.name', 'farm_market_rels.priority'])
          .where('farm_market_rels.farm_id', '=', farm.id)
          .orderBy('farm_market_rels.priority', 'asc')
          .execute();

        if (markets.length > 0) {
          contextParts.push(
            `CONNECTED MARKETS:\n${markets.map((m) => `  - ${m.name} (market_id: ${m.id}, priority: ${m.priority})`).join('\n')}`
          );
        }
      }
    }

    if (user.role === 'market' || user.role === 'both') {
      const market = await db
        .selectFrom('markets')
        .selectAll()
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      if (market) {
        contextParts.push(`MARKET: ${market.name} (id: ${market.id}), ${market.location}, type: ${market.type}, delivery preference: ${market.delivery_pref}`);

        // Connected farms with available inventory
        const farms = await db
          .selectFrom('farm_market_rels')
          .innerJoin('farms', 'farms.id', 'farm_market_rels.farm_id')
          .select(['farms.id', 'farms.name', 'farm_market_rels.priority'])
          .where('farm_market_rels.market_id', '=', market.id)
          .orderBy('farm_market_rels.priority', 'asc')
          .execute();

        if (farms.length > 0) {
          contextParts.push(
            `CONNECTED FARMS:\n${farms.map((f) => `  - ${f.name} (farm_id: ${f.id}, priority: ${f.priority})`).join('\n')}`
          );
        }
      }
    }
  } else {
    contextParts.push(
      `NEW USER: This phone number is not registered. Welcome them to FarmLink and ask for all signup info in one message: (1) their name, (2) role — farmer, market buyer, or both, (3) their city/location, and optionally their farm or business name. Once you have all info, call the user_signup tool. Keep it warm and concise — this is SMS.`
    );
  }

  // 6. Call Claude with tools
  const client = getAnthropic(env.ANTHROPIC_API_KEY);

  const messages: Anthropic.MessageParam[] = [
    // Include conversation history (oldest first)
    ...history.reverse().map((m) => ({
      role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.body,
    })),
    // Current message
    { role: 'user', content: message },
  ];

  // Deduplicate if the last history message IS the current message
  if (
    history.length > 0 &&
    history[history.length - 1]?.direction === 'inbound' &&
    history[history.length - 1]?.body === message
  ) {
    messages.pop();
  }

  const contextBlock = contextParts.length > 0 ? `\n\nCURRENT CONTEXT:\n${contextParts.join('\n')}` : '';

  const toolContext: ToolContext = { db, env, userId: user?.id, phone };

  let response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: SYSTEM_PROMPT + contextBlock,
    messages,
    tools: toolDefinitions,
  });

  // Track which tools (especially mutating ones) were called this turn so we can
  // verify Claude actually performed any action it claims in its final reply.
  const calledTools = new Set<string>();
  const successfulMutations = new Set<string>();

  // 7. Process tool calls in a loop (supports multi-step)
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      calledTools.add(toolUse.name);
      try {
        const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, toolContext);
        if (MUTATING_TOOLS.has(toolUse.name)) {
          // Treat as successful only if the tool didn't return an explicit error/needs_more flag
          const r = result as Record<string, unknown> | null | undefined;
          const failed =
            r && typeof r === 'object' && (('error' in r && r.error) || ('needs_price' in r && r.needs_price));
          if (!failed) successfulMutations.add(toolUse.name);
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          is_error: true,
        });
      }
    }

    // Continue the conversation with tool results
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: SYSTEM_PROMPT + contextBlock,
      messages,
      tools: toolDefinitions,
    });
  }

  // 7c. Verification pass: if Claude's final reply claims an action was taken
  // but no mutating tool was successfully invoked this turn, force a corrective
  // round so it actually calls the tool (or rewrites the message). We allow up
  // to 2 corrective attempts to avoid infinite loops if Claude refuses.
  let correctionAttempts = 0;
  while (correctionAttempts < 2) {
    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (!finalText || !responseClaimsAction(finalText)) break;
    if (successfulMutations.size > 0) break;

    correctionAttempts++;

    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content:
        'SYSTEM CHECK: Your previous reply implies you performed an action (added/created/updated/scheduled/etc.), but you did not actually call any data-modifying tool this turn. You MUST either: (1) call the appropriate tool right now to actually perform the action, then confirm only after it succeeds; or (2) if you do not have enough information, ask the user for what is missing instead of claiming success. Do not fabricate confirmations.',
    });

    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: SYSTEM_PROMPT + contextBlock,
      messages,
      tools: toolDefinitions,
      tool_choice: { type: 'any' },
    });

    // Drain any new tool calls triggered by the correction
    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        calledTools.add(toolUse.name);
        try {
          const result = await executeTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>,
            toolContext
          );
          if (MUTATING_TOOLS.has(toolUse.name)) {
            const r = result as Record<string, unknown> | null | undefined;
            const failed =
              r && typeof r === 'object' && (('error' in r && r.error) || ('needs_price' in r && r.needs_price));
            if (!failed) successfulMutations.add(toolUse.name);
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: SYSTEM_PROMPT + contextBlock,
        messages,
        tools: toolDefinitions,
      });
    }
  }

  // 7b. If signup just created a conversation, pick it up so we can store the response
  if (!conversation) {
    conversation = await db
      .selectFrom('conversations')
      .selectAll()
      .where('phone_number', '=', phone)
      .orderBy('last_message_at', 'desc')
      .executeTakeFirst();
  }

  // 8. Extract text response
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  const responseText = textBlocks.map((b) => b.text).join('\n') || "I'm sorry, I couldn't process that. Try again?";

  // 9. Store outbound message
  if (conversation) {
    await db
      .insertInto('messages')
      .values({
        conversation_id: conversation.id,
        direction: 'outbound',
        body: responseText,
        source: 'sms',
        ai_metadata: JSON.stringify({
          model: response.model,
          usage: response.usage,
          stop_reason: response.stop_reason,
          tools_called: Array.from(calledTools),
          mutations_succeeded: Array.from(successfulMutations),
          correction_attempts: correctionAttempts,
        }),
      })
      .execute();

    await db
      .updateTable('conversations')
      .set({ last_message_at: new Date(), context: conversation.context })
      .where('id', '=', conversation.id)
      .execute();
  }

  return responseText;
}
