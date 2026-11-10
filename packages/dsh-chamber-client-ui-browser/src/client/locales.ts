/** Locale-owned Browser tab copy. */
export const zh = {
  'type.label': '浏览器',
  'guide.title': '浏览器',
  'guide.description': '浏览网页',
  'shortcut.noSession': '请先打开一个会话',
  'address.placeholder': '输入 HTTP(S) 地址',
  back: '后退',
  forward: '前进',
  reload: '刷新',
  go: '前往',
  external: '在系统浏览器中打开',
  start: '输入 HTTP(S) 地址开始浏览',
  loading: '正在打开…',
  'restore.previous': '上次打开',
  'restore.action': '恢复页面',
  'error.empty': '请输入地址。',
  'error.invalid': '这个地址无效或过长。',
  'error.protocol': '只支持 HTTP 和 HTTPS 地址；本地文件请使用文档预览。',
  'error.credentials': '地址不能包含用户名或密码。',
  'error.application-origin': '不能在嵌入浏览器中打开 DSH 应用自身。',
  'load.failed': '页面加载失败；请刷新重试或在系统浏览器中打开。',
  'load.failed.detail': '页面加载失败 ({code}): {description}',
} satisfies Record<string, string>

/** Browser dictionary key union. */
export type SidebarBrowserKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en = {
  'type.label': 'Browser',
  'guide.title': 'Browser',
  'guide.description': 'Browse web pages',
  'shortcut.noSession': 'Open a session first',
  'address.placeholder': 'Enter an HTTP(S) address',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  go: 'Go',
  external: 'Open in system browser',
  start: 'Enter an HTTP(S) address to start browsing',
  loading: 'Opening…',
  'restore.previous': 'Previously opened',
  'restore.action': 'Restore page',
  'error.empty': 'Enter an address.',
  'error.invalid': 'That address is invalid or too long.',
  'error.protocol': 'Only HTTP and HTTPS addresses are supported; use Document Preview for local files.',
  'error.credentials': 'Addresses cannot contain a username or password.',
  'error.application-origin': 'The embedded browser cannot open the DSH application itself.',
  'load.failed': 'The page could not load; reload or open it in the system browser.',
  'load.failed.detail': 'Page load failed ({code}): {description}',
} satisfies Record<SidebarBrowserKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar Browser labels, navigation controls, and failures. */
    sidebarBrowser: SidebarBrowserKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'type.label': 'ブラウザ',
  'guide.title': 'ブラウザ',
  'guide.description': 'Webページを閲覧',
  'shortcut.noSession': '先にセッションを開いてください',
  'address.placeholder': 'HTTP(S)アドレスを入力',
  'back': '戻る',
  'forward': '進む',
  'reload': '再読み込み',
  'go': '移動',
  'external': 'システムブラウザで開く',
  'start': 'HTTP(S)アドレスを入力して閲覧を開始',
  'loading': '開いています…',
  'restore.previous': '前回開いたページ',
  'restore.action': 'ページを復元',
  'error.empty': 'アドレスを入力してください。',
  'error.invalid': 'アドレスが無効か、長すぎます。',
  'error.protocol': 'サポートされるのはHTTPとHTTPSのアドレスのみです。ローカルファイルにはドキュメントプレビューを使用してください。',
  'error.credentials': 'アドレスにユーザー名やパスワードを含めることはできません。',
  'error.application-origin': '埋め込みブラウザはDSHアプリ自体を開けません。',
  'load.failed': 'ページを読み込めませんでした。再読み込みするか、システムブラウザで開いてください。',
  'load.failed.detail': 'ページの読み込みに失敗しました（{code}）: {description}',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'type.label': 'Navegador',
  'guide.title': 'Navegador',
  'guide.description': 'Navegar por páginas web',
  'shortcut.noSession': 'Primero abra una sesión',
  'address.placeholder': 'Ingrese una dirección HTTP(S)',
  back: 'Atrás',
  forward: 'Adelante',
  reload: 'recargar',
  go: 'ir',
  external: 'Abrir en el navegador del sistema',
  start: 'Ingrese una dirección HTTP(S) para comenzar a navegar',
  loading: 'Abriendo…',
  'restore.previous': 'Abierto previamente',
  'restore.action': 'Restaurar página',
  'error.empty': 'Introduzca una dirección.',
  'error.invalid': 'Esa dirección no es válida o es demasiado larga.',
  'error.protocol': 'Sólo se admiten las direcciones HTTP y HTTPS; utilice la vista previa del documento para archivos locales.',
  'error.credentials': 'Las direcciones no pueden contener un nombre de usuario o contraseña.',
  'error.application-origin': 'El navegador integrado no puede abrir la aplicación DSH.',
  'load.failed': 'La página no se pudo cargar; recargarlo o abrirlo en el navegador del sistema.',
  'load.failed.detail': 'Error al cargar la página ({code}): {description}',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'type.label': 'Navigateur',
  'guide.title': 'Navigateur',
  'guide.description': 'Parcourir les pages Web',
  'shortcut.noSession': "Ouvrir d'abord une session",
  'address.placeholder': 'Saisissez une adresse HTTP(S)',
  back: 'Retour',
  forward: 'En avant',
  reload: 'Recharger',
  go: 'Allez',
  external: 'Ouvrir dans le navigateur système',
  start: 'Entrez une adresse HTTP(S) pour commencer la navigation',
  loading: 'Ouverture…',
  'restore.previous': 'Déjà ouvert',
  'restore.action': 'Page de restauration',
  'error.empty': 'Entrez une adresse.',
  'error.invalid': "Cette adresse n'est pas valide ou est trop longue.",
  'error.protocol': "Seules les adresses HTTP et HTTPS sont prises en charge ; utilisez l'aperçu du document pour les fichiers locaux.",
  'error.credentials': "Les adresses ne peuvent pas contenir de nom d'utilisateur ou de mot de passe.",
  'error.application-origin': "Le navigateur intégré ne peut pas ouvrir l'application DSH elle-même.",
  'load.failed': "La page n'a pas pu se charger ; rechargez-le ou ouvrez-le dans le navigateur système.",
  'load.failed.detail': 'Échec du chargement de la page ({code}) : {description}',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'type.label': 'Browser',
  'guide.title': 'Browser',
  'guide.description': 'Durchsuchen Sie Webseiten',
  'shortcut.noSession': 'Öffnen Sie zunächst eine Sitzung',
  'address.placeholder': 'Geben Sie eine HTTP(S)-Adresse ein',
  back: 'Zurück',
  forward: 'Vorwärts',
  reload: 'Neu laden',
  go: 'Geh',
  external: 'Im Systembrowser öffnen',
  start: 'Geben Sie eine HTTP(S)-Adresse ein, um mit dem Surfen zu beginnen',
  loading: 'Eröffnung…',
  'restore.previous': 'Zuvor geöffnet',
  'restore.action': 'Seite wiederherstellen',
  'error.empty': 'Geben Sie eine Adresse ein.',
  'error.invalid': 'Diese Adresse ist ungültig oder zu lang.',
  'error.protocol': 'Es werden nur die Adressen HTTP und HTTPS unterstützt. Verwenden Sie die Dokumentvorschau für lokale Dateien.',
  'error.credentials': 'Adressen dürfen weder einen Benutzernamen noch ein Passwort enthalten.',
  'error.application-origin': 'Der eingebettete Browser kann die DSH-Anwendung selbst nicht öffnen.',
  'load.failed': 'Die Seite konnte nicht geladen werden; neu laden oder im Systembrowser öffnen.',
  'load.failed.detail': 'Laden der Seite fehlgeschlagen ({code}): {description}',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'type.label': 'Браузер',
  'guide.title': 'Браузер',
  'guide.description': 'Просмотр веб-страниц',
  'shortcut.noSession': 'Сначала откройте сеанс',
  'address.placeholder': 'Введите адрес HTTP(S)',
  back: 'Назад',
  forward: 'Вперед',
  reload: 'Перезагрузить',
  go: 'Иди',
  external: 'Открыть в системном браузере',
  start: 'Введите адрес HTTP(S), чтобы начать просмотр.',
  loading: 'Открытие…',
  'restore.previous': 'Ранее открыто',
  'restore.action': 'Восстановить страницу',
  'error.empty': 'Введите адрес.',
  'error.invalid': 'Этот адрес недействителен или слишком длинный.',
  'error.protocol': 'Поддерживаются только адреса HTTP и HTTPS; используйте предварительный просмотр документа для локальных файлов.',
  'error.credentials': 'Адреса не могут содержать имя пользователя или пароль.',
  'error.application-origin': 'Встроенный браузер не может открыть само приложение DSH.',
  'load.failed': 'Страница не может загрузиться; перезагрузите или откройте его в системном браузере.',
  'load.failed.detail': 'Ошибка загрузки страницы ({code}): {description}',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'type.label': 'Navegador',
  'guide.title': 'Navegador',
  'guide.description': 'Navegar em páginas da web',
  'shortcut.noSession': 'Abra uma sessão primeiro',
  'address.placeholder': 'Insira um endereço HTTP(S)',
  back: 'Voltar',
  forward: 'Avançar',
  reload: 'Recarregar',
  go: 'Vá',
  external: 'Abrir no navegador do sistema',
  start: 'Insira um endereço HTTP(S) para começar a navegar',
  loading: 'Abrindo…',
  'restore.previous': 'Aberto anteriormente',
  'restore.action': 'Restaurar página',
  'error.empty': 'Insira um endereço.',
  'error.invalid': 'Esse endereço é inválido ou muito longo.',
  'error.protocol': 'Somente endereços HTTP e HTTPS são suportados; use a visualização do documento para arquivos locais.',
  'error.credentials': 'Os endereços não podem conter um nome de usuário ou senha.',
  'error.application-origin': 'O navegador incorporado não pode abrir o aplicativo DSH sozinho.',
  'load.failed': 'A página não pôde carregar; recarregue ou abra-o no navegador do sistema.',
  'load.failed.detail': 'Falha no carregamento da página ({code}): {description}',
} satisfies Record<keyof typeof en, string>
