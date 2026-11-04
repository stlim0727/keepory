import { Ionicons } from '@expo/vector-icons';
import { PostHogMaskView } from 'posthog-react-native';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '@/i18n';
import { ProtectedImage } from '@/ui/ProtectedImage';

export interface ImageViewerModalProps {
  visible: boolean;
  uri: string | null | undefined;
  title?: string | null;
  onClose: () => void;
  onShare?: () => void;
}

export function ImageViewerModal({
  visible,
  uri,
  title,
  onClose,
  onShare,
}: ImageViewerModalProps) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  if (!uri) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View testID="bookmark-detail-image-viewer" style={styles.backdrop}>
        <View
          style={[
            styles.header,
            { paddingTop: Math.max(insets.top, Platform.OS === 'web' ? 16 : 20) },
          ]}
        >
          <Pressable
            testID="bookmark-detail-viewer-close"
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            onPress={onClose}
            hitSlop={12}
            style={styles.iconButton}
          >
            <Ionicons name="close" size={24} color="#ffffff" />
          </Pressable>
          {title ? (
            <PostHogMaskView style={styles.titleContainer}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
            </PostHogMaskView>
          ) : (
            <View style={styles.titleSpacer} />
          )}
          {onShare ? (
            <Pressable
              testID="bookmark-detail-viewer-share"
              accessibilityRole="button"
              accessibilityLabel={t('common.share')}
              onPress={onShare}
              hitSlop={12}
              style={styles.iconButton}
            >
              <Ionicons name="share-outline" size={22} color="#ffffff" />
            </Pressable>
          ) : (
            <View style={styles.iconSpacer} />
          )}
        </View>
        <Pressable
          testID="bookmark-detail-viewer-backdrop"
          accessibilityRole="imagebutton"
          accessibilityLabel={t('detail.imageViewerDismiss')}
          style={styles.body}
          onPress={onClose}
        >
          <ProtectedImage
            testID="bookmark-detail-viewer-image"
            uri={uri}
            style={styles.image}
            resizeMode="contain"
          />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconSpacer: {
    width: 44,
    height: 44,
  },
  titleContainer: {
    flex: 1,
    marginHorizontal: 12,
  },
  titleSpacer: {
    flex: 1,
  },
  title: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  image: {
    width: '100%',
    height: '100%',
  },
});
