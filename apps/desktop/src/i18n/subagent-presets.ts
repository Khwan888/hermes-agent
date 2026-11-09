import type { BundledLocale } from './types'

/** Settings › Model › Subagents › Presets: the profile's named subagent presets. */
export interface SubagentPresetsCopy {
  title: string
  intro: string
  defaultPreset: string
  profileDefault: string
  presetName: string
  savePreset: string
  rename: string
  remove: string
  empty: string
  failed: string
}

export const subagentPresetsCopy: Record<BundledLocale, SubagentPresetsCopy> = {
  en: {
    title: 'Subagent presets',
    intro:
      "Save this profile's current subagent settings as a named preset. New chats that can use subagents start from the default preset; existing chats keep their settings.",
    defaultPreset: 'Default for new chats',
    profileDefault: 'Profile settings',
    presetName: 'Preset name',
    savePreset: 'Save current settings',
    rename: 'Rename',
    remove: 'Delete',
    empty: 'No presets yet.',
    failed: 'Could not update subagent presets.'
  },
  zh: {
    title: '子代理预设',
    intro: '将此配置文件当前的子代理设置保存为命名预设。可使用子代理的新对话从默认预设开始；现有对话保留其设置。',
    defaultPreset: '新对话默认预设',
    profileDefault: '配置文件设置',
    presetName: '预设名称',
    savePreset: '保存当前设置',
    rename: '重命名',
    remove: '删除',
    empty: '暂无预设。',
    failed: '无法更新子代理预设。'
  },
  'zh-hant': {
    title: '子代理預設',
    intro: '將此設定檔目前的子代理設定儲存為具名預設。可使用子代理的新對話會從預設開始；現有對話保留其設定。',
    defaultPreset: '新對話的預設',
    profileDefault: '設定檔設定',
    presetName: '預設名稱',
    savePreset: '儲存目前設定',
    rename: '重新命名',
    remove: '刪除',
    empty: '尚無預設。',
    failed: '無法更新子代理預設。'
  },
  ja: {
    title: 'サブエージェントのプリセット',
    intro:
      'このプロファイルの現在のサブエージェント設定を名前付きプリセットとして保存します。サブエージェントを使える新しいチャットは既定のプリセットから始まり、既存のチャットは設定を維持します。',
    defaultPreset: '新しいチャットの既定',
    profileDefault: 'プロファイルの設定',
    presetName: 'プリセット名',
    savePreset: '現在の設定を保存',
    rename: '名前を変更',
    remove: '削除',
    empty: 'プリセットはまだありません。',
    failed: 'サブエージェントのプリセットを更新できませんでした。'
  },
  ar: {
    title: 'إعدادات الوكلاء الفرعيين المحفوظة',
    intro:
      'احفظ إعدادات الوكلاء الفرعيين الحالية لهذا الملف الشخصي كإعداد مسبق مسمّى. تبدأ المحادثات الجديدة التي يمكنها استخدام الوكلاء الفرعيين من الإعداد الافتراضي، وتحتفظ المحادثات الحالية بإعداداتها.',
    defaultPreset: 'الافتراضي للمحادثات الجديدة',
    profileDefault: 'إعدادات الملف الشخصي',
    presetName: 'اسم الإعداد المسبق',
    savePreset: 'حفظ الإعدادات الحالية',
    rename: 'إعادة تسمية',
    remove: 'حذف',
    empty: 'لا توجد إعدادات مسبقة بعد.',
    failed: 'تعذّر تحديث إعدادات الوكلاء الفرعيين المسبقة.'
  },
  ru: {
    title: 'Пресеты субагентов',
    intro:
      'Сохраните текущие настройки субагентов этого профиля как именованный пресет. Новые чаты, которые могут использовать субагентов, начинают с пресета по умолчанию; существующие чаты сохраняют свои настройки.',
    defaultPreset: 'По умолчанию для новых чатов',
    profileDefault: 'Настройки профиля',
    presetName: 'Название пресета',
    savePreset: 'Сохранить текущие настройки',
    rename: 'Переименовать',
    remove: 'Удалить',
    empty: 'Пресетов пока нет.',
    failed: 'Не удалось обновить пресеты субагентов.'
  },
  fr: {
    title: 'Préréglages des sous-agents',
    intro:
      'Enregistrez les réglages actuels des sous-agents de ce profil comme préréglage nommé. Les nouvelles discussions pouvant utiliser des sous-agents partent du préréglage par défaut ; les discussions existantes gardent leurs réglages.',
    defaultPreset: 'Par défaut pour les nouvelles discussions',
    profileDefault: 'Réglages du profil',
    presetName: 'Nom du préréglage',
    savePreset: 'Enregistrer les réglages actuels',
    rename: 'Renommer',
    remove: 'Supprimer',
    empty: 'Aucun préréglage pour le moment.',
    failed: 'Impossible de mettre à jour les préréglages des sous-agents.'
  },
  de: {
    title: 'Subagenten-Vorlagen',
    intro:
      'Speichere die aktuellen Subagenten-Einstellungen dieses Profils als benannte Vorlage. Neue Chats, die Subagenten nutzen können, starten mit der Standardvorlage; bestehende Chats behalten ihre Einstellungen.',
    defaultPreset: 'Standard für neue Chats',
    profileDefault: 'Profileinstellungen',
    presetName: 'Vorlagenname',
    savePreset: 'Aktuelle Einstellungen speichern',
    rename: 'Umbenennen',
    remove: 'Löschen',
    empty: 'Noch keine Vorlagen.',
    failed: 'Subagenten-Vorlagen konnten nicht aktualisiert werden.'
  },
  es: {
    title: 'Preajustes de subagentes',
    intro:
      'Guarda la configuración actual de subagentes de este perfil como un preajuste con nombre. Los chats nuevos que pueden usar subagentes empiezan con el preajuste predeterminado; los chats existentes conservan su configuración.',
    defaultPreset: 'Predeterminado para chats nuevos',
    profileDefault: 'Configuración del perfil',
    presetName: 'Nombre del preajuste',
    savePreset: 'Guardar configuración actual',
    rename: 'Renombrar',
    remove: 'Eliminar',
    empty: 'Aún no hay preajustes.',
    failed: 'No se pudieron actualizar los preajustes de subagentes.'
  }
}
