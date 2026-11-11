import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { RootErrorBoundary } from '@/ui/RootErrorBoundary';
import { I18nProvider } from '@/i18n';

describe('RootErrorBoundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
  });

  it('renders error message, title, and actions', async () => {
    const error = new Error('Test crash in component');
    const retry = jest.fn();

    const screen = await render(
      <I18nProvider>
        <RootErrorBoundary error={error} retry={retry} />
      </I18nProvider>,
    );

    expect(screen.getByTestId('root-error-boundary')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    const messageEl = screen.getByTestId('root-error-boundary-message');
    expect(messageEl).toBeTruthy();
    expect(messageEl.props.children).toContain('Test crash in component');
    expect(screen.getByTestId('root-error-boundary-retry')).toBeTruthy();
    expect(screen.getByTestId('root-error-boundary-report')).toBeTruthy();
  });

  it('calls retry when the retry button is pressed', async () => {
    const error = new Error('Another error');
    const retry = jest.fn();

    const screen = await render(
      <I18nProvider>
        <RootErrorBoundary error={error} retry={retry} />
      </I18nProvider>,
    );

    fireEvent.press(screen.getByTestId('root-error-boundary-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shares diagnostic report when the report button is pressed', async () => {
    const error = new Error('Fatal render error');
    error.stack = 'Error: Fatal render error\n    at Component.render';
    const retry = jest.fn();

    const screen = await render(
      <I18nProvider>
        <RootErrorBoundary error={error} retry={retry} />
      </I18nProvider>,
    );

    fireEvent.press(screen.getByTestId('root-error-boundary-report'));

    await waitFor(() => {
      expect(Share.share).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Keepory Crash Report',
          message: expect.stringContaining('Fatal render error'),
        }),
      );
    });
  });

  it('gracefully renders without throwing if I18nProvider is absent', async () => {
    const error = new Error('Early bootstrap error');
    const retry = jest.fn();

    const screen = await render(<RootErrorBoundary error={error} retry={retry} />);

    expect(screen.getByTestId('root-error-boundary')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    const messageEl = screen.getByTestId('root-error-boundary-message');
    expect(messageEl).toBeTruthy();
    expect(messageEl.props.children).toContain('Early bootstrap error');
  });
});
