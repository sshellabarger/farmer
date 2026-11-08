'use client';

import type { AcknowledgementsInput, InsuranceAnswer } from '@/lib/phase4-types';
import { CheckRow, ExternalLink, NoteBox, RadioGroup, SectionHeading, TextField, type SectionProps } from './kit';
import { UploadField } from './upload-field';

type RuleAck = Exclude<keyof AcknowledgementsInput, 'own_booth_only'>;

/** Section 4: insurance and the five rule acknowledgements, then the typed signature. */
export function SectionAgreements({ values, update, config, draftId }: SectionProps & { draftId: string }) {
  const ins = values.insurance;
  const legal = config.legal;
  const setIns = (patch: Partial<typeof ins>) => update((v) => ({ ...v, insurance: { ...v.insurance, ...patch } }));
  const setAck = (key: RuleAck, on: boolean) => update((v) => ({ ...v, acknowledgements: { ...v.acknowledgements, [key]: on } }));
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const rulesHref = `/rules?market=${encodeURIComponent(config.market.id)}`;

  return (
    <div className="space-y-5">
      <SectionHeading title="Insurance and agreements" />

      <div className="space-y-3">
        <NoteBox>
          All vendors must carry $1,000,000 in general liability insurance naming KBK-Breck, The WLRFM and ALFN as additional insureds. Proof is
          required before your first market day.
          {legal.insurance_help_url && (
            <>
              {' '}
              <ExternalLink href={legal.insurance_help_url}>Insurance information sheet</ExternalLink>
            </>
          )}
        </NoteBox>

        <RadioGroup<InsuranceAnswer>
          legend="Your liability insurance"
          name="insurance_status"
          required
          value={ins.status}
          onChange={(s) => setIns({ status: s })}
          options={[
            { value: 'have', label: 'I have liability insurance' },
            { value: 'none', label: 'I do not have insurance yet' },
            { value: 'need_guidance', label: 'I need guidance getting insurance', hint: 'The market manager will help you.' },
          ]}
        />

        {ins.status === 'have' && (
          <div className="space-y-3">
            <UploadField
              id="insurance_file"
              label="Certificate of insurance (optional now, required before your first market)"
              kind="insurance"
              draftId={draftId}
              limits={config.limits}
              value={ins.certificate_upload_id ? { upload_id: ins.certificate_upload_id, name: ins.certificate_name || 'certificate' } : null}
              onChange={(file) => setIns({ certificate_upload_id: file ? file.upload_id : null, certificate_name: file ? file.name : '' })}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <TextField id="carrier" label="Insurance carrier" value={ins.carrier} onChange={(x) => setIns({ carrier: x })} maxLength={120} />
              <TextField id="expires_on" label="Policy expires on" type="date" value={ins.expires_on} onChange={(x) => setIns({ expires_on: x })} />
            </div>
          </div>
        )}
      </div>

      <fieldset className="border-0 p-0 m-0 min-w-0">
        <legend className="block text-[13px] font-semibold text-earth-700 mb-1.5 p-0">
          Rules and acknowledgements<span className="text-red-500" aria-hidden="true"> *</span>
        </legend>
        <div className="flex flex-col gap-2">
          <CheckRow checked={values.acknowledgements.rules} onChange={(on) => setAck('rules', on)}>
            I have read and agree to the{' '}
            {legal.has_rules_text ? (
              <ExternalLink href={rulesHref}>Rules and Regulations</ExternalLink>
            ) : legal.rules_url ? (
              <ExternalLink href={legal.rules_url}>Rules and Regulations</ExternalLink>
            ) : (
              'Rules and Regulations'
            )}
            {legal.rules_version && <span className="text-earth-500"> (version {legal.rules_version})</span>}
            {legal.has_rules_text && legal.rules_url && (
              <>
                {' '}
                <ExternalLink href={legal.rules_url}>Original document</ExternalLink>
              </>
            )}
            .
          </CheckRow>
          <CheckRow checked={values.acknowledgements.weekly_report} onChange={(on) => setAck('weekly_report', on)}>
            I will complete a market report each week, which helps the market manager see gaps in product availability.
          </CheckRow>
          <CheckRow checked={values.acknowledgements.farm_visits} onChange={(on) => setAck('farm_visits', on)}>
            I agree to random farm or facility visits to verify where my products come from.
          </CheckRow>
          <CheckRow checked={values.acknowledgements.marketing} onChange={(on) => setAck('marketing', on)}>
            The market may use my name, logo, photos and business description to promote the market.
          </CheckRow>
          <CheckRow checked={values.acknowledgements.products_listed_only} onChange={(on) => setAck('products_listed_only', on)}>
            I will sell only the items listed on this application. Additions during the season need the market manager&apos;s approval first.
          </CheckRow>
        </div>
      </fieldset>

      <p className="text-sm text-text-soft leading-relaxed m-0">
        If your application is accepted you will also be asked to sign the Hold Harmless agreement before your first market.
      </p>

      <div>
        <TextField
          id="signature_name"
          label="Type your full legal name"
          value={values.signature_name}
          onChange={(x) => update((v) => ({ ...v, signature_name: x }))}
          autoComplete="name"
          maxLength={120}
          required
          hint={`Typing your name is your signature on this application. Date: ${today}`}
        />
      </div>
    </div>
  );
}
