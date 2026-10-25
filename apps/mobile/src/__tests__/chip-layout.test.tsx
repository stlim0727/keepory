/**
 * Layout regression guards for the Chip component.
 *
 * These do not render on a real device, so they cannot prove the absence of
 * clipping. What they DO guarantee is that the specific style invariants we
 * added to fix the Browse-chip clipping (PR #62) can never silently regress:
 * without an explicit lineHeight, Android under-measures bold text and clips
 * the glyph descenders inside the pill.
 */
import { render } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { Chip } from '@/ui/Chip';
import { palettes } from '@/theme';

function labelStyle(node: { props: { style?: StyleProp<TextStyle> } }): TextStyle {
  return StyleSheet.flatten(node.props.style) as TextStyle;
}

function chipStyle(node: { props: { style?: StyleProp<ViewStyle> } }): ViewStyle {
  return StyleSheet.flatten(node.props.style) as ViewStyle;
}

test('chip label declares an explicit lineHeight (Android descender clip guard)', async () => {
  const { getByText } = await render(<Chip>All</Chip>);
  const style = labelStyle(getByText('All'));

  expect(typeof style.lineHeight).toBe('number');
});

test('chip label lineHeight leaves room for descenders (>= fontSize)', async () => {
  const { getByText } = await render(<Chip>No collection</Chip>);
  const style = labelStyle(getByText('No collection'));

  // A lineHeight smaller than the font size guarantees clipping; require at
  // least the font size so ascenders/descenders fit.
  expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize as number);
});

describe('Chip M3 variants', () => {
  const palette = palettes.light;

  test('assist variant renders soft sparkle container styling and default sparkles icon', async () => {
    const { getByText, getByTestId } = await render(
      <Chip variant="assist" testID="assist-chip">
        Ask AI
      </Chip>
    );

    const chip = chipStyle(getByTestId('assist-chip'));
    expect(chip.backgroundColor).toBe(palette.accentSoft);
    expect(chip.borderColor).toBe(palette.accent);

    const icon = getByTestId('chip-icon-sparkles-outline');
    expect(icon).toBeTruthy();

    const label = labelStyle(getByText('Ask AI'));
    expect(label.color).toBe(palette.accentText);
  });

  test('filter variant unselected vs selected styling', async () => {
    const { getByTestId: getUnselected } = await render(
      <Chip variant="filter" testID="filter-unselected">
        Filter
      </Chip>
    );
    const unselected = chipStyle(getUnselected('filter-unselected'));
    expect(unselected.backgroundColor).toBe(palette.surfaceContainerLow);

    const { getByTestId: getSelected } = await render(
      <Chip variant="filter" selected testID="filter-selected">
        Filter
      </Chip>
    );
    const selected = chipStyle(getSelected('filter-selected'));
    expect(selected.backgroundColor).toBe(palette.accentSoft);
    expect(selected.borderColor).toBe(palette.accent);
  });

  test('suggestion variant styling', async () => {
    const { getByTestId } = await render(
      <Chip variant="suggestion" testID="suggestion-chip">
        Suggested query
      </Chip>
    );
    const suggestion = chipStyle(getByTestId('suggestion-chip'));
    expect(suggestion.backgroundColor).toBe(palette.surfaceContainerLow);
    expect(suggestion.borderColor).toBe(palette.border);
  });
});
