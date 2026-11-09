import type { BundledLocale } from './types'

/** The typing-bar model menu's Subagents entry and its per-chat editor. */
export interface SubagentSettingsCopy {
  title: string
  intro: string
  depth: string
  concurrency: string
  reset: string
  savePreset: string
  presetName: string
  presets: string
  /** The model-menu row that opens this chat's subagent options. */
  custom: string
  /** Opens the full editor from the Subagents submenu. */
  edit: string
  /** Model-pill marker for a chat whose subagent settings differ from the profile's. */
  marker: string
  apply: string
  failed: string
  unavailable: string
  pendingSchema: string
}

export const subagentSettingsCopy: Record<BundledLocale, SubagentSettingsCopy> = {
  en: {
    title: 'Subagents for this chat',
    intro: 'Applies to the next subagent spawned in this chat. Subagents already running keep their settings.',
    depth: 'Nesting depth',
    concurrency: 'Max subagents at once',
    reset: 'Reset to profile default',
    savePreset: 'Save current as preset',
    presetName: 'Preset name',
    presets: 'Subagent presets',
    custom: 'Subagents',
    edit: 'Edit for this chat…',
    marker: 'Custom subagents',
    apply: 'Apply to this chat',
    failed: 'Could not update subagent settings.',
    unavailable: 'Update the backend to use per-chat subagent settings.',
    pendingSchema:
      'Route-mode or route-name changes wait for the next turn while this chat is running. Other changes apply to the next spawn.'
  },
  es: {
    title: 'Subagentes de este chat',
    intro: 'Se aplica al próximo subagente de este chat. Los que ya están ejecutándose conservan su configuración.',
    depth: 'Profundidad de anidación',
    concurrency: 'Máximo de subagentes simultáneos',
    reset: 'Restablecer al perfil',
    savePreset: 'Guardar como preajuste',
    presetName: 'Nombre del preajuste',
    presets: 'Preajustes de subagentes',
    custom: 'Subagentes',
    edit: 'Editar para este chat…',
    marker: 'Subagentes personalizados',
    apply: 'Aplicar a este chat',
    failed: 'No se pudo actualizar la configuración.',
    unavailable: 'Actualiza el backend para configurar subagentes por chat.',
    pendingSchema:
      'Los cambios de modo o nombres de rutas esperan al próximo turno si el chat está activo. Los demás cambios se aplican al próximo subagente.'
  },
  de: {
    title: 'Subagenten für diesen Chat',
    intro: 'Gilt für den nächsten Subagenten in diesem Chat. Laufende Subagenten behalten ihre Einstellungen.',
    depth: 'Verschachtelungstiefe',
    concurrency: 'Maximal gleichzeitige Subagenten',
    reset: 'Auf Profilstandard zurücksetzen',
    savePreset: 'Als Vorlage speichern',
    presetName: 'Vorlagenname',
    presets: 'Subagentenvorlagen',
    custom: 'Subagenten',
    edit: 'Für diesen Chat bearbeiten…',
    marker: 'Eigene Subagenten',
    apply: 'Auf diesen Chat anwenden',
    failed: 'Subagenteneinstellungen konnten nicht aktualisiert werden.',
    unavailable: 'Backend aktualisieren, um Subagenten pro Chat einzustellen.',
    pendingSchema:
      'Änderungen an Modus oder Routennamen warten bei laufendem Chat bis zum nächsten Zug. Andere Änderungen gelten beim nächsten Start.'
  },
  fr: {
    title: 'Sous-agents de cette discussion',
    intro: 'S’applique au prochain sous-agent lancé ici. Les sous-agents en cours conservent leurs réglages.',
    depth: 'Profondeur d’imbrication',
    concurrency: 'Sous-agents simultanés maximum',
    reset: 'Rétablir les réglages du profil',
    savePreset: 'Enregistrer comme préréglage',
    presetName: 'Nom du préréglage',
    presets: 'Préréglages des sous-agents',
    custom: 'Sous-agents',
    edit: 'Modifier pour cette discussion…',
    marker: 'Sous-agents personnalisés',
    apply: 'Appliquer à cette discussion',
    failed: 'Impossible de modifier les réglages.',
    unavailable: 'Mettez à jour le backend pour régler les sous-agents par discussion.',
    pendingSchema:
      'Si cette discussion est active, les changements de mode ou de noms de routes attendent le prochain tour. Les autres s’appliquent au prochain sous-agent.'
  },
  ja: {
    title: 'このチャットのサブエージェント',
    intro: '次に起動するサブエージェントに適用します。実行中のサブエージェントの設定は変わりません。',
    depth: 'ネストの深さ',
    concurrency: '同時サブエージェント数の上限',
    reset: 'プロファイルの既定に戻す',
    savePreset: '現在の設定をプリセットに保存',
    presetName: 'プリセット名',
    presets: 'サブエージェントのプリセット',
    custom: 'サブエージェント',
    edit: 'このチャット用に編集…',
    marker: 'カスタムサブエージェント',
    apply: 'このチャットに適用',
    failed: 'サブエージェント設定を更新できませんでした。',
    unavailable: 'チャット別の設定にはバックエンドを更新してください。',
    pendingSchema:
      '実行中のチャットでは、ルートモードやルート名の変更は次のターンから適用します。他の変更は次の起動から適用します。'
  },
  ru: {
    title: 'Субагенты этого чата',
    intro: 'Применяется к следующему субагенту в этом чате. Настройки работающих субагентов не меняются.',
    depth: 'Глубина вложенности',
    concurrency: 'Максимум субагентов одновременно',
    reset: 'Сбросить к настройкам профиля',
    savePreset: 'Сохранить как набор',
    presetName: 'Имя набора',
    presets: 'Наборы настроек субагентов',
    custom: 'Субагенты',
    edit: 'Изменить для этого чата…',
    marker: 'Свои субагенты',
    apply: 'Применить к этому чату',
    failed: 'Не удалось изменить настройки субагентов.',
    unavailable: 'Обновите сервер для настройки субагентов по чатам.',
    pendingSchema:
      'Изменения режима или имён маршрутов в активном чате ждут следующего хода. Остальные применяются к следующему субагенту.'
  },
  zh: {
    title: '此聊天的子代理',
    intro: '应用于此聊天下一次启动的子代理。正在运行的子代理保留原有设置。',
    depth: '嵌套深度',
    concurrency: '最大并行子代理数',
    reset: '恢复配置默认值',
    savePreset: '将当前设置保存为预设',
    presetName: '预设名称',
    presets: '子代理预设',
    custom: '子代理',
    edit: '为此聊天编辑…',
    marker: '自定义子代理',
    apply: '应用于此聊天',
    failed: '无法更新子代理设置。',
    unavailable: '请更新后端以使用每聊天子代理设置。',
    pendingSchema: '聊天运行期间，路由模式或路由名称的更改将在下一轮生效。其他更改应用于下一个子代理。'
  },
  'zh-hant': {
    title: '此聊天的子代理',
    intro: '套用至此聊天下一次啟動的子代理。執行中的子代理保留原有設定。',
    depth: '巢狀深度',
    concurrency: '最大同時子代理數',
    reset: '還原設定檔預設值',
    savePreset: '將目前設定儲存為預設集',
    presetName: '預設集名稱',
    presets: '子代理預設集',
    custom: '子代理',
    edit: '為此聊天編輯…',
    marker: '自訂子代理',
    apply: '套用至此聊天',
    failed: '無法更新子代理設定。',
    unavailable: '請更新後端以使用每聊天子代理設定。',
    pendingSchema: '聊天執行期間，路由模式或路由名稱的變更將於下一回合生效。其他變更套用至下一個子代理。'
  },
  ar: {
    title: 'الوكلاء الفرعيون لهذه المحادثة',
    intro: 'يُطبّق على الوكيل الفرعي التالي في هذه المحادثة. يحتفظ الوكلاء الفرعيون الجاري تشغيلهم بإعداداتهم.',
    depth: 'عمق التداخل',
    concurrency: 'أقصى عدد متزامن للوكلاء الفرعيين',
    reset: 'استعادة إعدادات الملف الافتراضية',
    savePreset: 'حفظ الحالي كإعداد مسبق',
    presetName: 'اسم الإعداد المسبق',
    presets: 'إعدادات الوكلاء الفرعيين المسبقة',
    custom: 'الوكلاء الفرعيون',
    edit: 'تعديل لهذه المحادثة…',
    marker: 'وكلاء فرعيون مخصصون',
    apply: 'تطبيق على هذه المحادثة',
    failed: 'تعذر تحديث إعدادات الوكلاء الفرعيين.',
    unavailable: 'حدّث الخادم لاستخدام إعدادات الوكلاء الفرعيين لكل محادثة.',
    pendingSchema:
      'تنتظر تغييرات وضع المسار أو أسماء المسارات الدور التالي أثناء تشغيل المحادثة. تُطبّق التغييرات الأخرى عند تشغيل الوكيل الفرعي التالي.'
  }
}
