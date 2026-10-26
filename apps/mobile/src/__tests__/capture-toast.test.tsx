import { act, fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Button, View } from 'react-native';

import { CaptureToastProvider, useCaptureToast } from '@/ui/capture-toast';
import type { CaptureToastAction, CaptureToastOptions } from '@/ui/capture-toast';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function TestTrigger({
  message,
  action,
  options,
  phaseFlow,
}: {
  message?: string;
  action?: CaptureToastAction;
  options?: CaptureToastOptions;
  phaseFlow?: {
    phase: 'saved' | 'enriching';
    onMoveToFolder?: () => void;
    onAddNote?: () => void;
    onView?: () => void;
    persisted?: Promise<boolean>;
  };
}) {
  const { show, showCapturePhase, dismiss } = useCaptureToast();

  useEffect(() => {
    if (phaseFlow) {
      showCapturePhase(phaseFlow.phase, {
        onMoveToFolder: phaseFlow.onMoveToFolder,
        onAddNote: phaseFlow.onAddNote,
        onView: phaseFlow.onView,
        persisted: phaseFlow.persisted,
        autoAdvance: false,
      });
    } else if (options) {
      show(message ?? 'Test', options);
    } else if (action) {
      show(message ?? 'Test', action);
    } else if (message) {
      show(message);
    }
  }, [show, showCapturePhase, message, action, options, phaseFlow]);

  return (
    <View>
      <Button testID="dismiss-btn" title="Dismiss" onPress={dismiss} />
    </View>
  );
}

describe('CaptureToastProvider (M3 Expressive Redesign)', () => {
  it('renders a floating pill snackbar in saved state with green checkmark', async () => {
    const { findByText, getByTestId } = await render(
      <CaptureToastProvider>
        <TestTrigger message="Saved locally" options={{ phase: 'saved' }} />
      </CaptureToastProvider>,
    );

    await findByText('Saved locally');
    expect(getByTestId('toast-checkmark')).toBeTruthy();
  });

  it('renders enriching state with sparkle icon and soft purple progress indicator', async () => {
    const { findByText, getByTestId } = await render(
      <CaptureToastProvider>
        <TestTrigger message="AI Analyzing..." options={{ phase: 'enriching' }} />
      </CaptureToastProvider>,
    );

    await findByText('AI Analyzing...');
    expect(getByTestId('toast-sparkle')).toBeTruthy();
    expect(getByTestId('toast-enriching-progress')).toBeTruthy();
  });

  it('renders quick action chips: [ 📂 Move to Folder ], [ ✎ Add Note ], [ View ↗ ]', async () => {
    const onMoveToFolder = jest.fn();
    const onAddNote = jest.fn();
    const onView = jest.fn();

    const { findByRole, findByText } = await render(
      <CaptureToastProvider>
        <TestTrigger
          phaseFlow={{
            phase: 'saved',
            onMoveToFolder,
            onAddNote,
            onView,
          }}
        />
      </CaptureToastProvider>,
    );

    await findByText('Saved locally');

    const folderChip = await findByRole('button', { name: 'Move to Folder' });
    const noteChip = await findByRole('button', { name: 'Add Note' });
    const viewChip = await findByRole('button', { name: 'View' });

    expect(folderChip).toBeTruthy();
    expect(noteChip).toBeTruthy();
    expect(viewChip).toBeTruthy();

    // Tap Move to Folder
    await act(async () => {
      fireEvent.press(folderChip);
    });
    expect(onMoveToFolder).toHaveBeenCalledTimes(1);

    // Tap Add Note
    await act(async () => {
      fireEvent.press(noteChip);
    });
    expect(onAddNote).toHaveBeenCalledTimes(1);

    // Tap View
    await act(async () => {
      fireEvent.press(viewChip);
    });
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it('preserves the "Capture is sacred" invariant — dismissal never disrupts background persistence', async () => {
    let persistedResolved = false;

    const mockPersisted = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        persistedResolved = true;
        resolve(true);
      }, 30);
    });

    const { findByText, getByTestId } = await render(
      <CaptureToastProvider>
        <TestTrigger
          phaseFlow={{
            phase: 'saved',
            persisted: mockPersisted,
          }}
        />
      </CaptureToastProvider>,
    );

    await findByText('Saved locally');

    // User dismisses toast early before persistence finishes
    const dismissBtn = getByTestId('dismiss-btn');
    await act(async () => {
      fireEvent.press(dismissBtn);
    });

    const result = await mockPersisted;
    expect(result).toBe(true);
    expect(persistedResolved).toBe(true);
  });

  it('preserves backwards compatibility with show(message, action)', async () => {
    const onAction = jest.fn();

    const { findByText, findByRole } = await render(
      <CaptureToastProvider>
        <TestTrigger
          message="Saved to Keepory"
          action={{
            label: 'View',
            onPress: onAction,
          }}
        />
      </CaptureToastProvider>,
    );

    await findByText('Saved to Keepory');
    const actionBtn = await findByRole('button', { name: 'View' });
    expect(actionBtn).toBeTruthy();

    await act(async () => {
      fireEvent.press(actionBtn);
    });
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
