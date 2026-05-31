import Anthropic from '@anthropic-ai/sdk';
import type { Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';
import { toolDefinitions, executeTool, type ToolContext } from '../tools/index.js';
import { v4 as uuid } from 'uuid';

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

DIRECTORY & CONNECTIONS:
- When a user wants to find or browse farms/markets, use directory_search.
- When a user wants to connect with a farm or market, use connection_request.
- When a user replies YES or NO to a connection request, use connection_respond.

WEB LINKS:
- When a user asks to SEE or LIST data that would produce a long response, call view_link.
- Keep the SMS short: one sentence + the link.

EMAIL REPORTS:
- When a user asks to EMAIL a report, use email_send.

FEEDBACK SYSTEM:
- Use feedback_submit to record feature requests or bug reports.
- Use feedback_query to list feedback items.

TOOL USE IS MANDATORY FOR ANY ACTION:
- NEVER claim you performed an action unless you actually invoked the matching tool.
- Only after a tool returns success may you confirm the action to the user.

Always respond naturally and concisely — remember this is SMS.`;

const MUTATING_TOOLS = new Set([
  'inventory_add', 'inventory_update', 'order_create', 'order_update',
  'recurring_order_create', 'recurring_order_update', 'delivery_schedule_set',
  'user_signup', 'feedback_submit', 'feedback_update', 'notify_markets',
]);

const ACTION_CLAIM_PATTERNS: RegExp[] = [
  /\b(added|listed|posted|created|placed|submitted|recorded|saved|logged|registered|signed[- ]?up|set\s+up|set\s+your|scheduled|booked|confirmed|cancell?ed|updated|changed|removed|deleted|reserved|marked\s+as)\b/i,
  /\b(i\s+(?:have|just|now)\s+(?:added|created|updated|placed|set|scheduled|registered|cancell?ed|removed|saved|recorded))\b/i,
  /\b(done|all\s+set|got\s+it\s+saved)\b/i,
];

function responseClaimsAction(text: string): boolean {
  return ACTION_CLAIM_PATTERNS.some((re) => re.test(text));
}

interface ProcessMessageInput {
  db: Firestore;
  env: Env;
  phone: string;
  message: string;
  messageSid: string;
}

export async function processInboundMessage(input: ProcessMessageInput): Promise<string> {
  const { db, env, phone, message } = input;

  // 1. Look up user by phone
  const userSnap = await db.collection('users').where('phone', '==', phone).limit(1).get();
  const user = userSnap.empty ? null : { id: userSnap.docs[0].id, ...userSnap.docs[0].data() as any };

  // 2. Get or create conversation
  const convoSnap = await db.collection('conversations')
    .where('phone_number', '==', phone)
    .orderBy('last_message_at', 'desc')
    .limit(1)
    .get();

  let convoId: string;
  let convoData: any;

  if (!convoSnap.empty) {
    convoId = convoSnap.docs[0].id;
    convoData = convoSnap.docs[0].data();
  } else {
    convoId = uuid();
    convoData = {
      user_id: user?.id || 'system',
      phone_number: phone,
      context: 'general',
      last_message_at: new Date(),
      created_at: new Date(),
    };
    await db.collection('conversations').doc(convoId).set(convoData);
  }

  // 3. Store inbound message
  await db.collection('conversations').doc(convoId).collection('messages').doc(uuid()).set({
    direction: 'inbound',
    body: message,
    source: 'sms',
    created_at: new Date(),
  });

  // 4. Load conversation history (last 20 messages)
  const historySnap = await db.collection('conversations').doc(convoId).collection('messages')
    .orderBy('created_at', 'desc')
    .limit(20)
    .get();

  const history = historySnap.docs.map((d) => d.data()).reverse();

  // 5. Build context for Claude
  const contextParts: string[] = [];

  if (user) {
    contextParts.push(`USER: ${user.name} (${user.role}), phone: ${user.phone}`);

    if (user.role === 'farmer' || user.role === 'both') {
      const farmSnap = await db.collection('farms').where('user_id', '==', user.id).limit(1).get();
      if (!farmSnap.empty) {
        const farm = { id: farmSnap.docs[0].id, ...farmSnap.docs[0].data() as any };
        contextParts.push(`FARM: ${farm.name} (id: ${farm.id}), ${farm.location}, specialty: ${farm.specialty || 'general'}`);

        if (farm.delivery_schedule?.length > 0) {
          contextParts.push(`DELIVERY SCHEDULE:\n${farm.delivery_schedule.map((s: any) => `  - ${s.day}: ${s.time_window}${s.areas?.length ? ` (${s.areas.join(', ')})` : ''}`).join('\n')}`);
        }

        const invSnap = await db.collection('inventory')
          .where('farm_id', '==', farm.id)
          .where('status', 'in', ['available', 'partial'])
          .get();

        if (invSnap.size > 0) {
          const items = await Promise.all(invSnap.docs.map(async (d) => {
            const inv = d.data();
            const prodDoc = await db.collection('products').doc(inv.product_id).get();
            const prod = prodDoc.data() || {};
            return `  - ${prod.name}: ${inv.remaining} ${prod.unit} @ $${inv.price}/${prod.unit} [${inv.status}] (inventory_id: ${d.id})`;
          }));
          contextParts.push(`ACTIVE INVENTORY:\n${items.join('\n')}`);
        }

        const relsSnap = await db.collection('farm_market_rels')
          .where('farm_id', '==', farm.id)
          .where('active', '==', true)
          .orderBy('priority')
          .get();

        if (relsSnap.size > 0) {
          const markets = await Promise.all(relsSnap.docs.map(async (d) => {
            const rel = d.data();
            const mDoc = await db.collection('markets').doc(rel.market_id).get();
            return `  - ${mDoc.data()?.name} (market_id: ${rel.market_id}, priority: ${rel.priority})`;
          }));
          contextParts.push(`CONNECTED MARKETS:\n${markets.join('\n')}`);
        }
      }
    }

    if (user.role === 'market' || user.role === 'both') {
      const marketSnap = await db.collection('markets').where('user_id', '==', user.id).limit(1).get();
      if (!marketSnap.empty) {
        const market = { id: marketSnap.docs[0].id, ...marketSnap.docs[0].data() as any };
        contextParts.push(`MARKET: ${market.name} (id: ${market.id}), ${market.location}, type: ${market.type}`);

        const relsSnap = await db.collection('farm_market_rels')
          .where('market_id', '==', market.id)
          .where('active', '==', true)
          .orderBy('priority')
          .get();

        if (relsSnap.size > 0) {
          const farms = await Promise.all(relsSnap.docs.map(async (d) => {
            const rel = d.data();
            const fDoc = await db.collection('farms').doc(rel.farm_id).get();
            return `  - ${fDoc.data()?.name} (farm_id: ${rel.farm_id}, priority: ${rel.priority})`;
          }));
          contextParts.push(`CONNECTED FARMS:\n${farms.join('\n')}`);
        }
      }
    }
  } else {
    contextParts.push('NEW USER: This phone number is not registered. Welcome them and ask for signup info: name, role (farmer/market), location, business name. Then call user_signup.');
  }

  // 6. Call Claude
  const client = getAnthropic(env.ANTHROPIC_API_KEY);

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m: any) => ({
      role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.body,
    })),
    { role: 'user', content: message },
  ];

  // Deduplicate if last history message is the current message
  if (history.length > 0 && history[history.length - 1]?.direction === 'inbound' && history[history.length - 1]?.body === message) {
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

  const calledTools = new Set<string>();
  const successfulMutations = new Set<string>();

  // 7. Process tool calls
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
          const r = result as Record<string, unknown> | null | undefined;
          const failed = r && typeof r === 'object' && (('error' in r && r.error) || ('needs_price' in r && r.needs_price));
          if (!failed) successfulMutations.add(toolUse.name);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
      } catch (err) {
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true });
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

  // Verification pass
  let correctionAttempts = 0;
  while (correctionAttempts < 2) {
    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text).join('\n');
    if (!finalText || !responseClaimsAction(finalText)) break;
    if (successfulMutations.size > 0) break;

    correctionAttempts++;
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: 'SYSTEM CHECK: Your reply claims an action was performed but no tool was called. Call the appropriate tool or ask the user for missing info.' });

    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 500,
      system: SYSTEM_PROMPT + contextBlock, messages, tools: toolDefinitions, tool_choice: { type: 'any' },
    });

    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        calledTools.add(toolUse.name);
        try {
          const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, toolContext);
          if (MUTATING_TOOLS.has(toolUse.name)) {
            const r = result as Record<string, unknown> | null | undefined;
            const failed = r && typeof r === 'object' && (('error' in r && r.error) || ('needs_price' in r && r.needs_price));
            if (!failed) successfulMutations.add(toolUse.name);
          }
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`, is_error: true });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 500, system: SYSTEM_PROMPT + contextBlock, messages, tools: toolDefinitions });
    }
  }

  // 8. Extract text response
  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
  const responseText = textBlocks.map((b) => b.text).join('\n') || "I'm sorry, I couldn't process that. Try again?";

  // 9. Store outbound message
  await db.collection('conversations').doc(convoId).collection('messages').doc(uuid()).set({
    direction: 'outbound',
    body: responseText,
    source: 'sms',
    ai_metadata: {
      model: response.model,
      usage: response.usage,
      tools_called: Array.from(calledTools),
      mutations_succeeded: Array.from(successfulMutations),
    },
    created_at: new Date(),
  });

  await db.collection('conversations').doc(convoId).update({ last_message_at: new Date() });

  return responseText;
}
