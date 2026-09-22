/**
 * Synthetic weekly-survey TSV builder for importer tests. Every name,
 * address and figure here is invented for testing — never a real survey
 * row (Phase 2 contract §7, HARD RULES).
 */

export const SURVEY_HEADER = [
  'Timestamp',
  'Vendor Name',
  'Email',
  'Estimated Total Sales',
  'sold out?',
  'attending next week?',
  'bringing next week',
  'feedback',
  'rotating weekly question',
  'transactions/customers',
  'did not sell',
  'Email Address',
  'winter-season interest',
];

export interface SurveyFixtureRow {
  timestamp: string;
  vendor_name: string;
  email?: string;
  estimated_total_sales?: string;
  sold_out?: string;
  attending_next_week?: string;
  bringing_next_week?: string;
  feedback?: string;
  weekly_question?: string;
  transactions?: string;
  did_not_sell?: string;
  email_address?: string;
  winter_interest?: string;
}

function tsvField(value: string | undefined): string {
  const v = value ?? '';
  if (/[\t\n\r"]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function rowToCells(row: SurveyFixtureRow): string[] {
  return [
    row.timestamp ?? '',
    row.vendor_name ?? '',
    row.email ?? '',
    row.estimated_total_sales ?? '',
    row.sold_out ?? '',
    row.attending_next_week ?? '',
    row.bringing_next_week ?? '',
    row.feedback ?? '',
    row.weekly_question ?? '',
    row.transactions ?? '',
    row.did_not_sell ?? '',
    row.email_address ?? '',
    row.winter_interest ?? '',
  ];
}

/**
 * Builds TSV text from rows. A row may be a `SurveyFixtureRow` object (all
 * 13 columns, defaulting blanks) or a raw `string[]` of fewer than 13 cells
 * — useful for simulating a Google Sheets export row with missing trailing
 * columns, which `parseTsv` pads back out to 13.
 */
export function buildSurveyTsv(rows: Array<SurveyFixtureRow | string[]>): string {
  const lines = [SURVEY_HEADER.map(tsvField).join('\t')];
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : rowToCells(row);
    lines.push(cells.map(tsvField).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The 10-row synthetic fixture used by `tests/import-survey.test.ts` and
 * checked in verbatim at `tests/fixtures/survey-synthetic.tsv`. Exercises:
 * two market Saturdays (2026-04-18, 2026-04-25) reached via same-day,
 * next-day, two-days-later and six-days-later responses; a 2-digit year
 * timestamp; a response before the season (unassigned); a quoted
 * multi-line feedback cell with an embedded literal quote; a row with
 * trailing columns missing; every `estimated_sales` and
 * `transactions_estimate` parse variant from the contract; a
 * `winter-season interest` answer; and three name/email variants of one
 * producer (business name, person name via a shared domain, and a longer
 * business spelling via the same email) that must resolve to a single
 * producer.
 */
export function syntheticFixtureRows(): Array<SurveyFixtureRow | string[]> {
  return [
    {
      timestamp: '4/18/2026 12:30:00',
      vendor_name: 'Testfield Farm',
      email: 'hello@testfield.example',
      estimated_total_sales: '$1,000.00',
      sold_out: 'Tomatoes, Corn',
      attending_next_week: 'Yes',
      bringing_next_week: 'Eggs, Honey',
      feedback: 'Great market today!',
      weekly_question: 'Blue',
      transactions: '80',
      did_not_sell: 'Kale',
    },
    {
      timestamp: '4/19/2026 9:00:00',
      vendor_name: 'Terry Testfield',
      estimated_total_sales: '500-1000',
      sold_out: 'No',
      attending_next_week: 'No',
      transactions: '80ish',
      email_address: 'terry@testfield.example',
    },
    {
      timestamp: '4/20/2026 10:15:00',
      vendor_name: 'Testfield Farm LLC',
      email: 'hello@testfield.example',
      estimated_total_sales: 'N/a',
      sold_out: 'None',
      transactions: '29 cards, 5 Cash App, and $200 cash',
    },
    {
      timestamp: '4/24/2026 23:59:00',
      vendor_name: 'Sunny Meadow Soap',
      email: 'sunnymeadowsoap@gmail.com',
      estimated_total_sales: '$45,690.00',
      sold_out: 'Lavender bars',
      attending_next_week: 'Yes',
      bringing_next_week: 'Candles',
      feedback: 'Busy Friday night market prep.',
    },
    {
      timestamp: '4/25/2026 13:00:00',
      vendor_name: 'Ridgeline Orchard',
      sold_out: 'Peaches, Apples',
      attending_next_week: 'Yes',
      bringing_next_week: 'Cider',
      transactions: '50',
      email_address: 'ridgeline.orchard@gmail.com',
      winter_interest: 'Maybe',
    },
    {
      timestamp: '4/25/26 14:30:00',
      vendor_name: 'Blue Bonnet Bakery',
      email: 'orders@bluebonnet.example',
      estimated_total_sales: '$250',
      sold_out: 'Sourdough',
      transactions: '12',
    },
    {
      timestamp: '3/1/2026 10:00:00',
      vendor_name: 'Early Bird Farm',
      email: 'info@earlybird.example',
    },
    {
      timestamp: '4/25/2026 15:00:00',
      vendor_name: 'Sunny Meadow Soap',
      feedback: 'Loved it!\nCustomers said "so soft" today.',
    },
    // Missing trailing columns: only timestamp, vendor, email, sales,
    // sold-out and attending are present — the rest is padded blank by
    // parseTsv, the way a truncated Sheets export row would come in.
    ['4/25/2026 16:00:00', 'Golden Hive Apiary', 'golden.hive@gmail.com', '$300', 'Honey', 'Yes'],
    {
      timestamp: '4/25/2026 17:30:00',
      vendor_name: 'Whispering Pines Maple',
      email: 'wp.maple@yahoo.com',
      estimated_total_sales: '$800',
      sold_out: 'Syrup',
      attending_next_week: 'No',
      transactions: '22',
    },
  ];
}

export function buildSyntheticFixture(): string {
  return buildSurveyTsv(syntheticFixtureRows());
}
