import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, useColorScheme } from 'react-native';

import {
  ProposedSummary,
  deriveAttributionBadge,
  mergeNoteSafely,
  type ProposedSummaryProps,
} from '@/ui/ProposedSummary';

jest.mock('react-native/Libraries/Utilities/useColorScheme');

const mockedUseColorScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;

describe('mergeNoteSafely (Non-destructive Note Merge Contract)', () => {
  test('empty note is filled by summary ("Use as note")', () => {
    expect(mergeNoteSafely('', 'AI generated summary')).toBe('AI generated summary');
    expect(mergeNoteSafely('   ', 'AI generated summary')).toBe('AI generated summary');
    expect(mergeNoteSafely(null, 'AI generated summary')).toBe('AI generated summary');
    expect(mergeNoteSafely(undefined, 'AI generated summary')).toBe('AI generated summary');
  });

  test('existing note is appended to, never overwritten ("Add to note")', () => {
    const existing = 'User hand-written note';
    const summary = 'AI key takeaways';
    const result = mergeNoteSafely(existing, summary);

    expect(result).toBe('User hand-written note\n\nAI key takeaways');
    // Ensure the original text remains intact at the beginning
    expect(result.startsWith(existing)).toBe(true);
  });

  test('empty summary preserves existing note without alteration', () => {
    expect(mergeNoteSafely('User hand-written note', '')).toBe('User hand-written note');
    expect(mergeNoteSafely('User hand-written note', '   ')).toBe('User hand-written note');
  });
});

describe('deriveAttributionBadge (Explainability indicator)', () => {
  test('defaults to content H2 key summary', () => {
    expect(deriveAttributionBadge()).toBe('[출처: 본문 H2 핵심 요약]');
    expect(deriveAttributionBadge({ source: 'content_h2' })).toBe('[출처: 본문 H2 핵심 요약]');
  });

  test('derives domain-based heuristic when degraded or domain source', () => {
    expect(deriveAttributionBadge({ degraded: true })).toBe('[도메인 기반 추천]');
    expect(deriveAttributionBadge({ source: 'domain_heuristic' })).toBe('[도메인 기반 추천]');
  });

  test('formats model identifier when provided', () => {
    expect(deriveAttributionBadge({ model: 'gemini-1.5-pro' })).toBe('[출처: gemini-1.5-pro]');
  });

  test('honors explicit attribution override', () => {
    expect(deriveAttributionBadge(undefined, '[출처: 본문 요약]')).toBe('[출처: 본문 요약]');
    expect(deriveAttributionBadge(undefined, '커스텀 출처')).toBe('[커스텀 출처]');
  });
});

describe('ProposedSummary Component', () => {
  const defaultProps: ProposedSummaryProps = {
    summary: 'Essential article takeaways for fast scanning.',
    noteEmpty: true,
    busy: false,
    onUse: jest.fn(),
    onDismiss: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseColorScheme.mockReturnValue('light');
  });

  test('renders light mode tonal surface (#f3e8ff)', async () => {
    mockedUseColorScheme.mockReturnValue('light');
    const { getByText } = await render(<ProposedSummary {...defaultProps} />);
    const summaryText = getByText(defaultProps.summary);
    let current: any = summaryText;
    let foundBg: string | undefined;
    while (current) {
      const flat = StyleSheet.flatten(current.props?.style);
      if (flat?.backgroundColor === '#f3e8ff') {
        foundBg = flat.backgroundColor;
        break;
      }
      current = current.parent;
    }
    expect(foundBg).toBe('#f3e8ff');
  });

  test('renders dark mode tonal surface (#311b92)', async () => {
    mockedUseColorScheme.mockReturnValue('dark');
    const { getByText } = await render(<ProposedSummary {...defaultProps} />);
    const summaryText = getByText(defaultProps.summary);
    let current: any = summaryText;
    let foundBg: string | undefined;
    while (current) {
      const flat = StyleSheet.flatten(current.props?.style);
      if (flat?.backgroundColor === '#311b92') {
        foundBg = flat.backgroundColor;
        break;
      }
      current = current.parent;
    }
    expect(foundBg).toBe('#311b92');
  });

  test('renders default explainability badge', async () => {
    const { getByText } = await render(<ProposedSummary {...defaultProps} />);
    expect(getByText('[출처: 본문 H2 핵심 요약]')).toBeTruthy();
  });

  test('renders domain heuristic explainability badge when degraded', async () => {
    const { getByText } = await render(
      <ProposedSummary {...defaultProps} metadata={{ degraded: true }} />,
    );
    expect(getByText('[도메인 기반 추천]')).toBeTruthy();
  });

  test('shows "Use as note" when note is empty', async () => {
    const { getByText } = await render(
      <ProposedSummary {...defaultProps} noteEmpty={true} />,
    );
    expect(getByText('Use as note')).toBeTruthy();
  });

  test('shows "Add to note" when note is not empty', async () => {
    const { getByText } = await render(
      <ProposedSummary {...defaultProps} noteEmpty={false} />,
    );
    expect(getByText('Add to note')).toBeTruthy();
  });

  test('derives noteEmpty from existingNote if noteEmpty prop omitted', async () => {
    const { getByText: getByTextEmpty } = await render(
      <ProposedSummary {...defaultProps} noteEmpty={undefined} existingNote="" />,
    );
    expect(getByTextEmpty('Use as note')).toBeTruthy();

    const { getByText: getByTextFilled } = await render(
      <ProposedSummary {...defaultProps} noteEmpty={undefined} existingNote="Existing user note" />,
    );
    expect(getByTextFilled('Add to note')).toBeTruthy();
  });

  test('calls onUse and onMergeNote with non-destructive merge when action button is tapped', async () => {
    const onUse = jest.fn();
    const onMergeNote = jest.fn();
    const { getByText } = await render(
      <ProposedSummary
        {...defaultProps}
        existingNote="Original note"
        noteEmpty={false}
        onUse={onUse}
        onMergeNote={onMergeNote}
      />,
    );

    await act(async () => {
      fireEvent.press(getByText('Add to note'));
    });
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onMergeNote).toHaveBeenCalledWith(
      `Original note\n\n${defaultProps.summary}`,
    );
  });

  test('supports one-tap tag adoption interaction chips if passed', async () => {
    const onAdoptTag = jest.fn();
    const tags = ['react', 'ai-design'];
    const { getByText } = await render(
      <ProposedSummary {...defaultProps} tags={tags} onAdoptTag={onAdoptTag} />,
    );

    expect(getByText('#react')).toBeTruthy();
    expect(getByText('#ai-design')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByText('#react'));
    });
    expect(onAdoptTag).toHaveBeenCalledWith('react');

    await act(async () => {
      fireEvent.press(getByText('#ai-design'));
    });
    expect(onAdoptTag).toHaveBeenCalledWith('ai-design');
  });

  test('triggers onDismiss when dismiss button is pressed', async () => {
    const onDismiss = jest.fn();
    const { getByText } = await render(
      <ProposedSummary {...defaultProps} onDismiss={onDismiss} />,
    );

    await act(async () => {
      fireEvent.press(getByText('Dismiss'));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
