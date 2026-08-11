/**
 * Starter cases for the question box.
 *
 * These mirror the routing eval in `scripts/eval.ts` on purpose: they are the
 * scenarios the pathway's behaviour is actually pinned to, so what a user tries
 * first is also what is regression-tested. Each one exercises a different arm.
 */

export interface SamplePrompt {
  /** Chip label — short enough to scan. */
  label: string;
  /** One line on what this case demonstrates. */
  hint: string;
  text: string;
}

export const SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    label: 'Plan and intent',
    hint: 'Specific plan with intent this week → high acuity',
    text:
      "16yo says that this week he has been thinking about taking all of his mother's pills and says he intends to do it. No prior attempts.",
  },
  {
    label: 'Recent attempt',
    hint: 'Denies current ideation, but an attempt 6 weeks ago still means high acuity',
    text:
      '15yo with an overdose attempt about six weeks ago. Currently denies any ideation, plan, or intent.',
  },
  {
    label: 'Thoughts, no plan',
    hint: 'Active thoughts within a month, nothing more → intermediate',
    text:
      '13yo reports thoughts of killing herself over the past two weeks, with no method, no plan, and no intent. She has never made an attempt and has never self-injured.',
  },
  {
    label: 'Passive wish',
    hint: 'Wish to be dead with no behavior history → low acuity',
    text:
      '14yo told her school counselor last week that she wishes she were dead. She denies any active thoughts of killing herself, has no method, plan, or intent, has never made an attempt or preparatory act, and has never self-injured.',
  },
  {
    label: 'Self-injury',
    hint: 'Non-suicidal self-injury within 3 months → low acuity, not a negative assessment',
    text:
      '15yo with cutting about two months ago, not with intent to die. Denies any wish to be dead and any suicidal thoughts, ever. No attempts or preparatory acts, ever.',
  },
  {
    label: 'Negative screen',
    hint: 'Exits the pathway without a risk assessment',
    text:
      '9yo here for a well visit. Screened for suicide risk today and the screen was negative. No concerns raised by parent or child.',
  },
  {
    label: 'Not enough detail',
    hint: 'Should ask a question rather than guess a branch',
    text: '14yo said last week she wishes she were dead.',
  },
];
