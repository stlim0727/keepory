import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';
import {
  SearchAnchor,
  SearchSuggestionShelf,
  getChipFamily,
} from '@/ui/SearchSuggestionShelf';
import type { SearchSuggestion } from '@/domain/search-suggestions';

function flattenStyle(node: { props: { style?: unknown } }): ViewStyle {
  return StyleSheet.flatten(node.props.style as any) as ViewStyle;
}

describe('M3 Search Anchor', () => {
  test('renders with M3 pill shape (radius 999), search icon, and shortcut badge', async () => {
    const screen = await render(
      <SearchAnchor placeholder="Search bookmarks..." shortcutBadge="⌘ K" />,
    );

    const anchor = screen.getByTestId('search-anchor');
    const anchorStyle = flattenStyle(anchor);
    expect(anchorStyle.borderRadius).toBe(999);
    expect(anchorStyle.borderWidth).toBe(1);

    expect(screen.getByTestId('search-anchor-icon')).toBeTruthy();
    expect(screen.getByTestId('search-anchor-input')).toBeTruthy();
    expect(screen.getByTestId('search-anchor-shortcut-badge')).toBeTruthy();
    expect(screen.getByText('⌘ K')).toBeTruthy();
  });

  test('calls onChangeText and displays clear button when text is entered in uncontrolled mode', async () => {
    const onChangeText = jest.fn();
    const onClear = jest.fn();

    const screen = await render(
      <SearchAnchor onChangeText={onChangeText} onClear={onClear} />,
    );

    expect(screen.queryByTestId('search-anchor-clear')).toBeNull();

    const input = screen.getByTestId('search-anchor-input');
    await act(async () => {
      fireEvent.changeText(input, 'local-first');
    });
    expect(onChangeText).toHaveBeenCalledWith('local-first');

    const clearBtn = screen.getByTestId('search-anchor-clear');
    expect(clearBtn).toBeTruthy();

    await act(async () => {
      fireEvent.press(clearBtn);
    });
    expect(onClear).toHaveBeenCalled();
  });

  test('submits query on submit editing', async () => {
    const onSubmit = jest.fn();
    const screen = await render(
      <SearchAnchor value="testing" onSubmit={onSubmit} />,
    );

    const input = screen.getByTestId('search-anchor-input');
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });
    expect(onSubmit).toHaveBeenCalledWith('testing');
  });
});

describe('3-Tier Semantic Chip Rail', () => {
  const mockSuggestions: SearchSuggestion[] = [
    {
      kind: 'folder',
      key: 'folder:work',
      label: 'Work',
      count: 12,
    },
    {
      kind: 'assist',
      key: 'assist:unread',
      label: '3 unread AI summaries',
    },
    {
      kind: 'recent',
      key: 'recent:local-first',
      label: 'local-first',
      query: 'local-first',
    },
    {
      kind: 'tag',
      key: 'tag:design',
      label: '#design',
    },
  ];

  test('getChipFamily categorizes chip kinds correctly into 3 tiers', () => {
    expect(getChipFamily(mockSuggestions[0])).toBe('filter');
    expect(getChipFamily(mockSuggestions[1])).toBe('assist');
    expect(getChipFamily(mockSuggestions[2])).toBe('suggestion');
    expect(getChipFamily(mockSuggestions[3])).toBe('suggestion');
  });

  test('SearchSuggestionShelf renders all 3 chip families with differentiated styling', async () => {
    const onPick = jest.fn();

    const screen = await render(
      <SearchSuggestionShelf
        suggestions={mockSuggestions}
        onPick={onPick}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy());

    // 1. Filter chip (folder)
    const folderChip = screen.getByTestId('suggestion-folder-folder:work');
    expect(folderChip).toBeTruthy();
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.getByText('· 12')).toBeTruthy();

    // 2. AI Assist chip (sparkles)
    const assistChip = screen.getByTestId('suggestion-assist-assist:unread');
    expect(assistChip).toBeTruthy();
    expect(screen.getByTestId('chip-icon-sparkles')).toBeTruthy();
    expect(screen.getByText('3 unread AI summaries')).toBeTruthy();
    const assistStyle = flattenStyle(assistChip);
    expect(assistStyle.borderRadius).toBe(999);
    // Soft purple container background
    expect(assistStyle.backgroundColor).toBe('#f3e8ff');

    // 3. Suggestion chip (recent search with clock icon)
    const recentChip = screen.getByTestId('suggestion-recent-recent:local-first');
    expect(recentChip).toBeTruthy();
    expect(screen.getByTestId('chip-icon-time-outline')).toBeTruthy();
    expect(screen.getByText('local-first')).toBeTruthy();

    // 4. Tag suggestion chip
    const tagChip = screen.getByTestId('suggestion-tag-tag:design');
    expect(tagChip).toBeTruthy();
    expect(screen.getByText('#design')).toBeTruthy();

    // Press interaction works across families
    await act(async () => {
      fireEvent.press(folderChip);
    });
    expect(onPick).toHaveBeenCalledWith(mockSuggestions[0]);

    await act(async () => {
      fireEvent.press(assistChip);
    });
    expect(onPick).toHaveBeenCalledWith(mockSuggestions[1]);
  });

  test('SearchSuggestionShelf integrates SearchAnchor when showAnchor is true', async () => {
    const screen = await render(
      <SearchSuggestionShelf
        suggestions={mockSuggestions}
        onPick={jest.fn()}
        showAnchor
        query="initial query"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('search-anchor')).toBeTruthy());
    expect(screen.getByTestId('search-suggestion-shelf')).toBeTruthy();
  });
});
