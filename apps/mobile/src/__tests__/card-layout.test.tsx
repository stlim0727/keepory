import { render } from '@testing-library/react-native';
import { StyleSheet, Text, type ViewStyle } from 'react-native';

import { Card } from '@/ui/Card';
import { palettes } from '@/theme';

describe('Card primitive', () => {
  const palette = palettes.light;

  test('borderless tonal by default', async () => {
    const { getByTestId } = await render(
      <Card testID="test-card">
        <Text>Content</Text>
      </Card>
    );
    const element = getByTestId('test-card');
    const flattened = StyleSheet.flatten(element.props.style) as ViewStyle;

    expect(flattened.borderWidth).toBe(0);
    expect(flattened.backgroundColor).toBe(palette.card);
  });

  test('shows border when bordered prop is true', async () => {
    const { getByTestId } = await render(
      <Card testID="test-card" bordered>
        <Text>Content</Text>
      </Card>
    );
    const element = getByTestId('test-card');
    const flattened = StyleSheet.flatten(element.props.style) as ViewStyle;

    expect(flattened.borderWidth).toBe(1);
    expect(flattened.borderColor).toBe(palette.border);
  });

  test('shows border and shadow when elevated prop is true', async () => {
    const { getByTestId } = await render(
      <Card testID="test-card" elevated>
        <Text>Content</Text>
      </Card>
    );
    const element = getByTestId('test-card');
    const flattened = StyleSheet.flatten(element.props.style) as ViewStyle;

    expect(flattened.borderWidth).toBe(1);
    expect(flattened.borderColor).toBe(palette.border);
    expect(flattened.shadowOpacity).toBe(palette.shadow.card.shadowOpacity);
  });

  test('shows accent border and accentSoft background when selected prop is true', async () => {
    const { getByTestId } = await render(
      <Card testID="test-card" selected>
        <Text>Content</Text>
      </Card>
    );
    const element = getByTestId('test-card');
    const flattened = StyleSheet.flatten(element.props.style) as ViewStyle;

    expect(flattened.borderWidth).toBe(2);
    expect(flattened.borderColor).toBe(palette.accent);
    expect(flattened.backgroundColor).toBe(palette.accentSoft);
  });
});
