/* ============================================================
   SalesTrack — i18n
   English (en) · Russian (ru) · Uzbek Latin (uz)

   Usage from JS:
       i18n.t('product.added')              // → translated text
       i18n.t('sale.sold', { quantity: 2, name: 'Atlas' })
       i18n.setLang('ru')                   // switches + persists + re-applies DOM
       i18n.getLang()                       // → 'en' | 'ru' | 'uz'

   Usage from HTML:
       <span data-i18n="nav.dashboard">Dashboard</span>
       <input data-i18n-placeholder="topbar.searchPlaceholder">
       <button data-i18n-title="topbar.toggleTheme" data-i18n-aria-label="topbar.toggleTheme">

   Listen for changes:
       document.addEventListener('i18n:change', e => console.log(e.detail.lang));
   ============================================================ */

(function () {
    'use strict';

    var STORAGE_KEY = 'salestrack-lang';

    /* ------------------------------------------------------------------
       LANGUAGES (display order)
       ------------------------------------------------------------------ */
    var langs = [
        { code: 'en', name: 'English',  native: 'English' },
        { code: 'ru', name: 'Russian',  native: 'Русский' },
        { code: 'uz', name: 'Uzbek',    native: 'Oʻzbekcha' }
    ];

    /* ------------------------------------------------------------------
       DICTIONARIES
       Keys are grouped by feature area.
       Interpolation uses {placeholder} syntax — see sale.sold / restock.added.
       ------------------------------------------------------------------ */
    var dict = {

        /* ============================ ENGLISH ============================ */
        en: {
            // Brand
            'brand.name': 'Bazar',
            'brand.tagline': 'Merchant Dashboard',

            // Navigation / sidebar actions
            'nav.home':            'Home',
            'nav.dashboard':       'Dashboard',
            'nav.categories':      'Categories',
            'nav.products':        'Products',
            'nav.posTerminal':     'POS Terminal',
            'nav.analytics':       'Analytics',
            'nav.activity':        'Activity Log',
            'action.dailyReset':   'Daily Reset',
            'action.exportJson':   'Export JSON',
            'action.importJson':   'Import JSON',
            'action.clearAllData': 'Clear All Data',
            'action.confirmClearAllData': 'Are you sure you want to delete ALL data from the database and local storage? This will erase all products, categories, sales, and history. This action cannot be undone.',
            'action.clearAllDataSuccess': 'Database and local data cleared successfully.',

            // Topbar
            'topbar.searchPlaceholder': 'Search products...',
            'topbar.toggleTheme':       'Toggle theme',
            'topbar.language':          'Language',

            // Dashboard cards
            'dash.soldToday':       'Products Sold Today',
            'dash.liveTracking':    'Live tracking',
            'dash.totalCategories': 'Total Categories',
            'dash.trackedStock':    'Tracked Stock',
            'dash.bestCategory':    'Best Category',
            'dash.topProduct':      'Top Selling Product',
            'dash.worstCategory':   'Worst Category',
            'dash.totalRevenue':    'Total Revenue',
            'dash.totalProducts':   'Total Products',
            'dash.recent':          'Recent Activity',
            'dash.viewAll':         'View All',
            'dash.noRecent':        'No recent activity',

            // Charts
            'chart.categoryPerformance':     'Category Performance',
            'chart.dailyTrend':              'Daily Sales Trend',
            'chart.categoryDistribution':    'Category Sales Distribution',
            'chart.productSalesDistribution':'Product Sales Distribution',
            'chart.productPerformance':      'Product Performance Comparison',
            'chart.salesTrend':              'Sales Trend Over Time',
            'chart.noData':                  'No Data',
            'chart.unitsSold':               'Units Sold',
            'chart.dailySales':              'Daily Sales',
            'chart.totalSold':               'Total Sold',

            // Categories
            'category.title':           'Categories',
            'category.add':             'Add Category',
            'category.edit':            'Edit Category',
            'category.delete':          'Delete Category',
            'category.empty':           'No categories yet. Create your first category!',
            'category.name':            'Category Name',
            'category.namePlaceholder': 'e.g. Outerwear, Footwear...',
            'category.create':          'Create Category',
            'category.deleteConfirm':   'Deleting this category will also delete all its products. Continue?',
            'category.totalSold':       'Total Sold',
            'category.inStock':         'In Stock',
            'category.revenue':         'Revenue',
            'category.products':        'Products',
            'category.added':           'Category added',
            'category.updated':         'Category updated',
            'category.deleted':         'Category deleted',
            'category.nameRequired':    'Category name is required',
            'category.exists':          'A category with this name already exists',
            'category.first':           'Please create a category first',

            // Products
            'product.title':               'Products',
            'product.add':                 'Add Product',
            'product.edit':                'Edit Product',
            'product.delete':              'Delete Product',
            'product.empty':               'No products found.',
            'product.allCategories':       'All Categories',
            'product.sortName':            'Sort by Name',
            'product.sortSold':            'Sort by Sold',
            'product.sortStock':           'Sort by Stock',
            'product.sortPrice':           'Sort by Price',
            'product.nameLabel':           'Product Name',
            'product.namePlaceholder':     'e.g. Atlas Jacket',
            'product.categoryLabel':       'Category',
            'product.quantityLabel':       'Quantity',
            'product.quantityHint':        'Optional — leave empty if inventory isn\'t tracked',
            'product.quantityPlaceholder': 'Leave empty if untracked',
            'product.priceLabel':          'Base Catalog Price (thousand soʻm) *',
            'product.pricePlaceholder':    '140',
            'product.priceHint':           'Enter in thousands: 1 = 1 000 soʻm, 140 = 140 000 soʻm',
            'product.priceRequired':       'Base catalog price is required and must be greater than 0',
            'currency.thousandSum':        'ming soʻm',
            'product.notesLabel':          'Notes',
            'product.notesPlaceholder':    'Any notes...',
            'product.imageLabel':          'Product Image',
            'product.imageDropzone':       'Click or drag image here (max 5MB)',
            'product.imageChange':         'Change Image',
            'product.imageRemove':         'Remove',
            'product.imageInvalid':        'Please upload a valid image (JPEG, PNG, WebP) under 5MB',
            'product.untracked':           'Untracked',
            'product.outOfStock':          'Out of stock',
            'product.inStock':             'In Stock',
            'product.totalSold':           'Total Sold',
            'product.price':               'Price',
            'product.sell':                'Sell',
            'product.restock':             'Restock',
            'product.notFound':            'Product not found',
            'product.noStock':             'Not enough stock',
            'product.confirmDelete':       'Are you sure you want to delete this product?',
            'product.added':               'Product added',
            'product.updated':             'Product updated',
            'product.deleted':             'Product deleted',
            'product.nameRequired':        'Product name is required',
            'product.categoryRequired':    'Please select a category',

            // Sell modal
            'sale.title':             'Sell',
            'sale.quantity':          'Quantity',
            'sale.notes':             'Notes (optional)',
            'sale.notesPlaceholder':  'e.g. Customer bought 2 jackets, Reserved item...',
            'sale.confirm':           'Confirm Sale',
            'sale.sold':              'Sold {quantity} × {name}',
            'sale.undo':              'Undo',
            'sale.undone':            'Sale undone successfully',
            'sale.cannotUndo':        'Cannot undo this action',
            'sale.productGone':       'Product no longer exists',

            // Restock modal
            'restock.title':            'Restock',
            'restock.amount':           'Amount to Add',
            'restock.notes':            'Notes (optional)',
            'restock.notesPlaceholder': 'e.g. New shipment arrived',
            'restock.confirm':          'Add Stock',
            'restock.added':            'Added {amount} to stock',

            // Analytics
            'analytics.title':          'Analytics & Insights',
            'analytics.insights':       'Smart Insights',
            'analytics.topPerformer':   'Top Performer',
            'analytics.needsAttention': 'Needs Attention',
            'analytics.fastMoving':     'Fast Moving',
            'analytics.slowMoving':     'Slow Moving',

            // Activity log
            'activity.title':           'Activity Log',
            'activity.clearHistory':    'Clear History',
            'activity.confirmClear':    'Delete all activity logs? This cannot be undone.',
            'activity.cleared':         'Activity log cleared',
            'activity.none':            'No activity recorded',
            'activity.system':          'System',
            'activity.qty':             'Qty',
            'activity.filterAll':       'All Activities',
            'activity.filterSale':      'Sales',
            'activity.filterReturn':    'Returns',
            'activity.filterCreate':    'Created',
            'activity.filterUpdate':    'Updated',
            'activity.filterDelete':    'Deleted',
            'activity.editNote':        'Edit Note',
            'activity.editNotePrompt':  'Edit note:',
            'activity.noteUpdated':     'Note updated',

            // Activity table headers
            'table.time':     'Time',
            'table.action':   'Action',
            'table.product':  'Product',
            'table.category': 'Category',
            'table.qty':      'Qty',
            'table.notes':    'Notes',
            'table.actions':  'Actions',

            // Activity type labels (also used as icon initial)
            'type.sale':   'Sale',
            'type.return': 'Return',
            'type.create': 'Created',
            'type.update': 'Updated',
            'type.delete': 'Deleted',
            'type.note':   'Note',

            // Daily reset
            'reset.title':   'Daily Reset',
            'reset.confirm': "This will reset today's counters and archive current day data. Continue?",
            'reset.done':    'Daily counters reset',

            // Common
            'common.cancel':      'Cancel',
            'common.save':        'Save Changes',
            'common.edit':        'Edit',
            'common.delete':      'Delete',
            'common.confirm':     'Confirm',
            'common.areYouSure':  'Are you sure?',
            'common.cannotUndo':  'This action cannot be undone.',

            // Data import/export
            'data.exported':     'Data exported successfully',
            'data.imported':     'Data imported successfully',
            'data.invalidFile':  'Invalid file format',
            'data.importFailed': 'Failed to import file',
            'data.storageError': 'Storage error: data may not persist',
            'data.demoLoaded':   'Demo data loaded successfully',

            // POS / Sellers Terminal
            'pos.title':                  'Bazar — Seller POS',
            'pos.terminalBadge':          'POS Terminal',
            'pos.salesToday':             'Sales Today',
            'pos.revenue':                'Revenue',
            'pos.extraProfit':            'Extra Profit',
            'pos.syncStatus':             'POS Synchronization status',
            'pos.synced':                 'Synced',
            'pos.syncing':                'Syncing',
            'pos.syncingCount':           'Syncing ({count})...',
            'pos.offline':                'Offline',
            'pos.offlineCount':           'Offline ({count})',
            'pos.syncIssues':             '{count} sync issue{plural}',
            'pos.saved':                  'Saved',
            'pos.syncFailed':             'Sync failed',
            'pos.searchPlaceholder':      'Search products or SKU...',
            'pos.filterAll':              'All Items',
            'pos.filterInStock':          'In Stock',
            'pos.filterLowStock':         'Low Stock',
            'pos.productCount':           '{count} product{plural}',
            'pos.viewGrid':               'Grid view',
            'pos.viewList':               'List view',
            'pos.lowStockBadge':          'Low stock',
            'pos.outOfStockBadge':        'Out of stock',
            'pos.newBadge':               'New',
            'pos.untracked':              'untracked',
            'pos.inStock':                'in stock',
            'pos.recordSale':             'Record Sale',
            'pos.recordSaleTitle':        'Record Sale',
            'pos.quantity':               'Quantity',
            'pos.onlyItemsAvailable':     'Only {max} items available.',
            'pos.sellingPrice':           'Selling Price (per unit in ming soʻm)',
            'pos.thousandSum':            'ming soʻm',
            'pos.basePrice':              'Base catalog price',
            'pos.totalBaseValue':         'Total base value',
            'pos.unitSellingPrice':       'Unit selling price',
            'pos.totalSaleAmount':        'Total sale amount',
            'pos.atBasePrice':            'At base catalog price',
            'pos.enterSellingPrice':      'Enter a selling price',
            'pos.discount':               'Discount / reduction',
            'pos.cancel':                 'Cancel',
            'pos.confirmSale':            'Confirm Sale',
            'pos.saving':                 'Saving…',
            'pos.emptyCatalogTitle':      'No products in catalog',
            'pos.emptyCatalogSub':        'Create your first products in the Admin Panel to start selling.',
            'pos.openAdmin':              'Open Admin Panel',
            'pos.noMatchTitle':           'No matching products',
            'pos.noMatchSub':             'Try adjusting your keyword or filter criteria.',
            'pos.toastNewProduct':        'New product added: {name}',
            'pos.toastUpdatedProduct':    'Product updated: {name}',
            'pos.toastRemovedProduct':    'Product removed from catalog',
            'pos.toastValidQty':          'Enter a valid quantity.',
            'pos.toastStockLimit':        'Only {stock} items in stock.',
            'pos.toastValidPrice':        'Enter a valid selling price.',
            'pos.toastSaleSuccess':       '{name} × {qty} · Sold for {total}',
            'pos.toastSoldAtBase':        'Sold at catalog price',
            'pos.toastExtraProfit':       'Extra profit: +{amount}',
            'pos.toastDiscount':          'Discount: −{amount}',
            'pos.toastInsufficientStock': '🚨 Sale rejected: Insufficient stock on server.'
        },

        /* ============================ RUSSIAN ============================ */
        ru: {
            'brand.name':    'Bazar',
            'brand.tagline': 'Панель торговца',

            'nav.home':          'Главная',
            'nav.dashboard':     'Панель',
            'nav.categories':    'Категории',
            'nav.products':      'Товары',
            'nav.posTerminal':   'POS Терминал',
            'nav.analytics':     'Аналитика',
            'nav.activity':      'История',
            'action.dailyReset': 'Сброс за день',
            'action.exportJson': 'Экспорт JSON',
            'action.importJson': 'Импорт JSON',
            'action.clearAllData': 'Очистить базу данных',
            'action.confirmClearAllData': 'Вы уверены, что хотите удалить ВСЕ данные из базы данных и локального хранилища? Будут удалены все товары, категории, продажи и история. Это действие нельзя отменить.',
            'action.clearAllDataSuccess': 'База данных и локальные данные успешно очищены.',

            'topbar.searchPlaceholder': 'Поиск товаров...',
            'topbar.toggleTheme':       'Сменить тему',
            'topbar.language':          'Язык',

            'dash.soldToday':       'Продано сегодня',
            'dash.liveTracking':    'В реальном времени',
            'dash.totalCategories': 'Всего категорий',
            'dash.trackedStock':    'Товаров на складе',
            'dash.bestCategory':    'Лучшая категория',
            'dash.topProduct':      'Хит продаж',
            'dash.worstCategory':   'Худшая категория',
            'dash.totalRevenue':    'Общая выручка',
            'dash.totalProducts':   'Всего товаров',
            'dash.recent':          'Последние события',
            'dash.viewAll':         'Смотреть все',
            'dash.noRecent':        'Нет недавних событий',

            'chart.categoryPerformance':     'Показатели категорий',
            'chart.dailyTrend':              'Динамика за день',
            'chart.categoryDistribution':    'Распределение по категориям',
            'chart.productSalesDistribution':'Распределение продаж товаров',
            'chart.productPerformance':      'Сравнение товаров',
            'chart.salesTrend':              'Динамика продаж',
            'chart.noData':                  'Нет данных',
            'chart.unitsSold':               'Продано штук',
            'chart.dailySales':              'Продажи за день',
            'chart.totalSold':               'Всего продано',

            'category.title':           'Категории',
            'category.add':             'Добавить категорию',
            'category.edit':            'Изменить категорию',
            'category.delete':          'Удалить категорию',
            'category.empty':           'Категорий пока нет. Создайте первую категорию!',
            'category.products':        'Товаров',
            'category.totalSold':       'Всего продано',
            'category.inStock':         'На складе',
            'category.revenue':         'Выручка',
            'category.name':            'Название категории',
            'category.namePlaceholder': 'например, Одежда, Электроника',
            'category.create':          'Создать категорию',
            'category.confirmDelete':   'Это удалит категорию и все её товары. Продолжить?',
            'category.nameRequired':    'Введите название категории',
            'category.duplicate':       'Такая категория уже существует',
            'category.created':         'Категория создана',
            'category.updated':         'Категория обновлена',
            'category.deleted':         'Категория удалена',
            'category.first':           'Сначала создайте категорию',

            'product.title':               'Товары',
            'product.add':                 'Добавить товар',
            'product.edit':                'Изменить товар',
            'product.delete':              'Удалить товар',
            'product.empty':               'Товары не найдены.',
            'product.allCategories':       'Все категории',
            'product.sortName':            'По названию',
            'product.sortSold':            'По продажам',
            'product.sortStock':           'По остатку',
            'product.sortPrice':           'По цене',
            'product.nameLabel':           'Название товара',
            'product.namePlaceholder':     'например, Куртка «Атлас»',
            'product.categoryLabel':       'Категория',
            'product.quantityLabel':       'Количество',
            'product.quantityHint':        'Необязательно — оставьте пустым, если остаток не ведётся',
            'product.quantityPlaceholder': 'Оставьте пустым, если без учёта',
            'product.priceLabel':          'Базовая цена каталога (тыс. сум) *',
            'product.pricePlaceholder':    '140',
            'product.priceHint':           'Указывайте в тысячах: 1 = 1 000 сум, 140 = 140 000 сум',
            'product.priceRequired':       'Базовая цена каталога обязательна и должна быть больше 0',
            'currency.thousandSum':        'тыс. сум',
            'product.notesLabel':          'Заметки',
            'product.notesPlaceholder':    'Любые заметки...',
            'product.imageLabel':          'Изображение товара',
            'product.imageDropzone':       'Нажмите или перетащите фото сюда (макс. 5 МБ)',
            'product.imageChange':         'Сменить фото',
            'product.imageRemove':         'Удалить',
            'product.imageInvalid':        'Пожалуйста, загрузите изображение (JPEG, PNG, WebP) до 5 МБ',
            'product.untracked':           'Без учёта',
            'product.outOfStock':          'Нет в наличии',
            'product.inStock':             'На складе',
            'product.totalSold':           'Всего продано',
            'product.price':               'Цена',
            'product.sell':                'Продать',
            'product.restock':             'Пополнить',
            'product.notFound':            'Товар не найден',
            'product.noStock':             'Недостаточно на складе',
            'product.confirmDelete':       'Вы уверены, что хотите удалить этот товар?',
            'product.added':               'Товар добавлен',
            'product.updated':             'Товар обновлён',
            'product.deleted':             'Товар удалён',
            'product.nameRequired':        'Введите название товара',
            'product.categoryRequired':    'Выберите категорию',

            'sale.title':            'Продать',
            'sale.quantity':         'Количество',
            'sale.notes':            'Заметки (необязательно)',
            'sale.notesPlaceholder': 'например, клиент купил 2 куртки, бронь...',
            'sale.confirm':          'Подтвердить продажу',
            'sale.sold':             'Продано {quantity} × {name}',
            'sale.undo':             'Отменить',
            'sale.undone':           'Продажа отменена',
            'sale.cannotUndo':       'Невозможно отменить это действие',
            'sale.productGone':      'Товар больше не существует',

            'restock.title':            'Пополнить',
            'restock.amount':           'Количество к добавлению',
            'restock.notes':            'Заметки (необязательно)',
            'restock.notesPlaceholder': 'например, новая поставка',
            'restock.confirm':          'Добавить на склад',
            'restock.added':            'Добавлено {amount} на склад',

            'analytics.title':          'Аналитика и инсайты',
            'analytics.insights':       'Умные подсказки',
            'analytics.topPerformer':   'Лидер продаж',
            'analytics.needsAttention': 'Требует внимания',
            'analytics.fastMoving':     'Быстро уходит',
            'analytics.slowMoving':     'Медленно уходит',

            'activity.title':          'История операций',
            'activity.clearHistory':   'Очистить историю',
            'activity.confirmClear':   'Удалить всю историю? Это действие необратимо.',
            'activity.cleared':        'История очищена',
            'activity.none':           'Записей пока нет',
            'activity.system':         'Система',
            'activity.qty':            'Кол-во',
            'activity.filterAll':      'Все события',
            'activity.filterSale':     'Продажи',
            'activity.filterReturn':   'Возвраты',
            'activity.filterCreate':   'Создания',
            'activity.filterUpdate':   'Изменения',
            'activity.filterDelete':   'Удаления',
            'activity.editNote':       'Изменить заметку',
            'activity.editNotePrompt': 'Изменить заметку:',
            'activity.noteUpdated':    'Заметка обновлена',

            'table.time':     'Время',
            'table.action':   'Действие',
            'table.product':  'Товар',
            'table.category': 'Категория',
            'table.qty':      'Кол-во',
            'table.notes':    'Заметки',
            'table.actions':  'Действия',

            'type.sale':   'Продажа',
            'type.return': 'Возврат',
            'type.create': 'Создано',
            'type.update': 'Изменено',
            'type.delete': 'Удалено',
            'type.note':   'Заметка',

            'reset.title':   'Сброс за день',
            'reset.confirm': 'Это сбросит счётчики дня и заархивирует данные. Продолжить?',
            'reset.done':    'Дневные счётчики сброшены',

            'common.cancel':     'Отмена',
            'common.save':       'Сохранить',
            'common.edit':       'Изменить',
            'common.delete':     'Удалить',
            'common.confirm':    'Подтвердить',
            'common.areYouSure': 'Вы уверены?',
            'common.cannotUndo': 'Это действие необратимо.',

            'data.exported':     'Данные успешно экспортированы',
            'data.imported':     'Данные успешно импортированы',
            'data.invalidFile':  'Неверный формат файла',
            'data.importFailed': 'Не удалось импортировать файл',
            'data.storageError': 'Ошибка хранилища: данные могут не сохраниться',
            'data.demoLoaded':   'Демо-данные загружены',

            // POS / Sellers Terminal
            'pos.title':                  'Bazar — POS Продавца',
            'pos.terminalBadge':          'POS Терминал',
            'pos.salesToday':             'Продажи сегодня',
            'pos.revenue':                'Выручка',
            'pos.extraProfit':            'Доп. прибыль',
            'pos.syncStatus':             'Статус синхронизации POS',
            'pos.synced':                 'Синхронизировано',
            'pos.syncing':                'Синхронизация',
            'pos.syncingCount':           'Синхронизация ({count})...',
            'pos.offline':                'Офлайн',
            'pos.offlineCount':           'Офлайн ({count})',
            'pos.syncIssues':             '{count} ошибок синхронизации',
            'pos.saved':                  'Сохранено',
            'pos.syncFailed':             'Ошибка синхронизации',
            'pos.searchPlaceholder':      'Поиск товаров или SKU...',
            'pos.filterAll':              'Все товары',
            'pos.filterInStock':          'В наличии',
            'pos.filterLowStock':         'Мало на складе',
            'pos.productCount':           '{count} тов.',
            'pos.viewGrid':               'Сетка',
            'pos.viewList':               'Список',
            'pos.lowStockBadge':          'Мало',
            'pos.outOfStockBadge':        'Нет в наличии',
            'pos.newBadge':               'Новинка',
            'pos.untracked':              'без учёта',
            'pos.inStock':                'в наличии',
            'pos.recordSale':             'Оформить продажу',
            'pos.recordSaleTitle':        'Оформить продажу',
            'pos.quantity':               'Количество',
            'pos.onlyItemsAvailable':     'Доступно всего {max} шт.',
            'pos.sellingPrice':           'Цена продажи (за шт. в тыс. сум)',
            'pos.thousandSum':            'тыс. сум',
            'pos.basePrice':              'Базовая цена каталога',
            'pos.totalBaseValue':         'Итого по базовой цене',
            'pos.unitSellingPrice':       'Цена продажи за единицу',
            'pos.totalSaleAmount':        'Итоговая сумма продажи',
            'pos.atBasePrice':            'По базовой цене каталога',
            'pos.enterSellingPrice':      'Введите цену продажи',
            'pos.discount':               'Скидка / уценка',
            'pos.cancel':                 'Отмена',
            'pos.confirmSale':            'Подтвердить продажу',
            'pos.saving':                 'Сохранение…',
            'pos.emptyCatalogTitle':      'Нет товаров в каталоге',
            'pos.emptyCatalogSub':        'Добавьте первые товары в панели администратора, чтобы начать продажи.',
            'pos.openAdmin':              'Открыть панель администратора',
            'pos.noMatchTitle':           'Товары не найдены',
            'pos.noMatchSub':             'Попробуйте изменить поисковый запрос или фильтр.',
            'pos.toastNewProduct':        'Добавлен новый товар: {name}',
            'pos.toastUpdatedProduct':    'Товар обновлён: {name}',
            'pos.toastRemovedProduct':    'Товар удалён из каталога',
            'pos.toastValidQty':          'Укажите корректное количество.',
            'pos.toastStockLimit':        'На складе осталось только {stock} шт.',
            'pos.toastValidPrice':        'Укажите корректную цену продажи.',
            'pos.toastSaleSuccess':       '{name} × {qty} · Продано на {total}',
            'pos.toastSoldAtBase':        'Продано по базовой цене',
            'pos.toastExtraProfit':       'Доп. прибыль: +{amount}',
            'pos.toastDiscount':          'Скидка: −{amount}',
            'pos.toastInsufficientStock': '🚨 Продажа отклонена: недостаточно товара на сервере.'
        },

        /* ============================ UZBEK (Latin) ============================ */
        uz: {
            'brand.name':    'Bazar',
            'brand.tagline': 'Savdogar paneli',

            'nav.home':          'Asosiy',
            'nav.dashboard':     'Boshqaruv paneli',
            'nav.categories':    'Kategoriyalar',
            'nav.products':      'Mahsulotlar',
            'nav.posTerminal':   'POS Terminali',
            'nav.analytics':     'Tahlil',
            'nav.activity':      'Faoliyat tarixi',
            'action.dailyReset': 'Kunlik tiklash',
            'action.exportJson': 'JSON eksport',
            'action.importJson': 'JSON import',
            'action.clearAllData': 'Bazani tozalash',
            'action.confirmClearAllData': 'Barcha maʼlumotlarni bazadan va xotiradan butunlay oʻchirmoqchimisiz? Barcha mahsulotlar, toifalar, sotuvlar va tarix oʻchiriladi. Bu amalni ortga qaytarib boʻlmaydi.',
            'action.clearAllDataSuccess': 'Baza va barcha maʼlumotlar muvaffaqiyatli tozalandi.',

            'topbar.searchPlaceholder': 'Mahsulot qidirish...',
            'topbar.toggleTheme':       'Mavzuni almashtirish',
            'topbar.language':          'Til',

            'dash.soldToday':       'Bugun sotilgan',
            'dash.liveTracking':    'Jonli kuzatuv',
            'dash.totalCategories': 'Jami kategoriyalar',
            'dash.trackedStock':    'Ombordagi tovarlar',
            'dash.bestCategory':    'Eng yaxshi kategoriya',
            'dash.topProduct':      'Eng ko‘p sotilgan',
            'dash.worstCategory':   'Eng yomon kategoriya',
            'dash.totalRevenue':    'Umumiy daromad',
            'dash.totalProducts':   'Jami mahsulotlar',
            'dash.recent':          'Soʻnggi harakatlar',
            'dash.viewAll':         'Hammasini koʻrish',
            'dash.noRecent':        'Soʻnggi harakatlar yoʻq',

            'chart.categoryPerformance':     'Kategoriyalar samaradorligi',
            'chart.dailyTrend':              'Kunlik savdo dinamikasi',
            'chart.categoryDistribution':    'Kategoriyalar boʻyicha taqsimot',
            'chart.productSalesDistribution':'Mahsulotlar savdosi taqsimoti',
            'chart.productPerformance':      'Mahsulotlar taqqoslovi',
            'chart.salesTrend':              'Savdo dinamikasi',
            'chart.noData':                  'Maʼlumot yoʻq',
            'chart.unitsSold':               'Sotilgan dona',
            'chart.dailySales':              'Kunlik savdo',
            'chart.totalSold':               'Jami sotilgan',

            'category.title':           'Kategoriyalar',
            'category.add':             'Kategoriya qoʻshish',
            'category.edit':            'Kategoriyani tahrirlash',
            'category.delete':          'Kategoriyani oʻchirish',
            'category.empty':           'Hozircha kategoriyalar yoʻq. Birinchi kategoriyangizni yarating!',
            'category.products':        'Mahsulotlar',
            'category.totalSold':       'Jami sotilgan',
            'category.inStock':         'Omborda',
            'category.revenue':         'Daromad',
            'category.name':            'Kategoriya nomi',
            'category.namePlaceholder': 'masalan, Kiyim, Elektronika',
            'category.create':          'Kategoriya yaratish',
            'category.confirmDelete':   'Bu kategoriya va uning barcha mahsulotlarini oʻchiradi. Davom etilsinmi?',
            'category.nameRequired':    'Kategoriya nomi kerak',
            'category.duplicate':       'Bunday kategoriya allaqachon mavjud',
            'category.created':         'Kategoriya yaratildi',
            'category.updated':         'Kategoriya yangilandi',
            'category.deleted':         'Kategoriya oʻchirildi',
            'category.first':           'Avval kategoriya yarating',

            'product.title':               'Mahsulotlar',
            'product.add':                 'Mahsulot qoʻshish',
            'product.edit':                'Mahsulotni tahrirlash',
            'product.delete':              'Mahsulotni oʻchirish',
            'product.empty':               'Mahsulotlar topilmadi.',
            'product.allCategories':       'Barcha kategoriyalar',
            'product.sortName':            'Nom boʻyicha',
            'product.sortSold':            'Sotuvi boʻyicha',
            'product.sortStock':           'Qoldigʻi boʻyicha',
            'product.sortPrice':           'Narxi boʻyicha',
            'product.nameLabel':           'Mahsulot nomi',
            'product.namePlaceholder':     'masalan, "Atlas" kurtkasi',
            'product.categoryLabel':       'Kategoriya',
            'product.quantityLabel':       'Miqdori',
            'product.quantityHint':        'Ixtiyoriy — qoldiq hisobi yuritilmasa, boʻsh qoldiring',
            'product.quantityPlaceholder': 'Hisoblanmasa, boʻsh qoldiring',
            'product.priceLabel':          'Asosiy katalog narxi (ming soʻm) *',
            'product.pricePlaceholder':    '140',
            'product.priceHint':           'Ming soʻmda kiriting: 1 = 1 000 soʻm, 140 = 140 000 soʻm',
            'product.priceRequired':       'Asosiy katalog narxi kiritilishi shart va 0 dan katta boʻlishi kerak',
            'currency.thousandSum':        'ming soʻm',
            'product.notesLabel':          'Izohlar',
            'product.notesPlaceholder':    'Har qanday izoh...',
            'product.imageLabel':          'Mahsulot rasmi',
            'product.imageDropzone':       'Rasmni tanlang yoki bu yerga sudrab tashlang (maks. 5 MB)',
            'product.imageChange':         'Rasmni almashtirish',
            'product.imageRemove':         'Oʻchirish',
            'product.imageInvalid':        'Iltimos, haqiqiy rasm faylini (JPEG, PNG, WebP) yuklang (5 MB gacha)',
            'product.untracked':           'Hisoblanmaydi',
            'product.outOfStock':          'Tugagan',
            'product.inStock':             'Omborda',
            'product.totalSold':           'Jami sotilgan',
            'product.price':               'Narxi',
            'product.sell':                'Sotish',
            'product.restock':             'Toʻldirish',
            'product.notFound':            'Mahsulot topilmadi',
            'product.noStock':             'Omborda yetarli emas',
            'product.confirmDelete':       'Ushbu mahsulotni oʻchirishni xohlaysizmi?',
            'product.added':               'Mahsulot qoʻshildi',
            'product.updated':             'Mahsulot yangilandi',
            'product.deleted':             'Mahsulot oʻchirildi',
            'product.nameRequired':        'Mahsulot nomi kerak',
            'product.categoryRequired':    'Kategoriyani tanlang',

            'sale.title':            'Sotish',
            'sale.quantity':         'Miqdori',
            'sale.notes':            'Izoh (ixtiyoriy)',
            'sale.notesPlaceholder': 'masalan, mijoz 2 dona oldi, zaxiraga olindi...',
            'sale.confirm':          'Savdoni tasdiqlash',
            'sale.sold':             '{quantity} × {name} sotildi',
            'sale.undo':             'Bekor qilish',
            'sale.undone':           'Savdo bekor qilindi',
            'sale.cannotUndo':       'Ushbu amalni bekor qilib boʻlmaydi',
            'sale.productGone':      'Mahsulot endi mavjud emas',

            'restock.title':            'Toʻldirish',
            'restock.amount':           'Qoʻshiladigan miqdor',
            'restock.notes':            'Izoh (ixtiyoriy)',
            'restock.notesPlaceholder': 'masalan, yangi yetkazib berish keldi',
            'restock.confirm':          'Omborga qoʻshish',
            'restock.added':            'Omborga {amount} qoʻshildi',

            'analytics.title':          'Tahlil va xulosalar',
            'analytics.insights':       'Aqlli xulosalar',
            'analytics.topPerformer':   'Lider',
            'analytics.needsAttention': 'Eʼtibor talab qiladi',
            'analytics.fastMoving':     'Tez sotiladi',
            'analytics.slowMoving':     'Sekin sotiladi',

            'activity.title':          'Faoliyat tarixi',
            'activity.clearHistory':   'Tarixni tozalash',
            'activity.confirmClear':   'Barcha tarixni oʻchirishni xohlaysizmi? Bu amalni qaytarib boʻlmaydi.',
            'activity.cleared':        'Faoliyat tarixi tozalandi',
            'activity.none':           'Yozuvlar hali yoʻq',
            'activity.system':         'Tizim',
            'activity.qty':            'Miqdor',
            'activity.filterAll':      'Barcha harakatlar',
            'activity.filterSale':     'Savdolar',
            'activity.filterReturn':   'Qaytarishlar',
            'activity.filterCreate':   'Yaratildi',
            'activity.filterUpdate':   'Yangilandi',
            'activity.filterDelete':   'Oʻchirildi',
            'activity.editNote':       'Izohni tahrirlash',
            'activity.editNotePrompt': 'Izohni tahrirlash:',
            'activity.noteUpdated':    'Izoh yangilandi',

            'table.time':     'Vaqt',
            'table.action':   'Harakat',
            'table.product':  'Mahsulot',
            'table.category': 'Kategoriya',
            'table.qty':      'Miqdor',
            'table.notes':    'Izohlar',
            'table.actions':  'Amallar',

            'type.sale':   'Savdo',
            'type.return': 'Qaytarish',
            'type.create': 'Yaratildi',
            'type.update': 'Yangilandi',
            'type.delete': 'Oʻchirildi',
            'type.note':   'Izoh',

            'reset.title':   'Kunlik tiklash',
            'reset.confirm': 'Bu bugungi hisoblagichlarni qayta tiklaydi va kun maʼlumotlarini arxivga oladi. Davom etilsinmi?',
            'reset.done':    'Kunlik hisoblagichlar tiklandi',

            'common.cancel':     'Bekor qilish',
            'common.save':       'Saqlash',
            'common.edit':       'Tahrirlash',
            'common.delete':     'Oʻchirish',
            'common.confirm':    'Tasdiqlash',
            'common.areYouSure': 'Ishonchingiz komilmi?',
            'common.cannotUndo': 'Bu amalni qaytarib boʻlmaydi.',

            'data.exported':     'Maʼlumotlar muvaffaqiyatli eksport qilindi',
            'data.imported':     'Maʼlumotlar muvaffaqiyatli import qilindi',
            'data.invalidFile':  'Fayl formati notoʻgʻri',
            'data.importFailed': 'Faylni import qilib boʻlmadi',
            'data.storageError': 'Saqlash xatosi: maʼlumotlar saqlanmasligi mumkin',
            'data.demoLoaded':   'Demo maʼlumotlar yuklandi',

            // POS / Sellers Terminal
            'pos.title':                  'Bazar — Sotuvchi POS',
            'pos.terminalBadge':          'POS Terminali',
            'pos.salesToday':             'Bugungi savdo',
            'pos.revenue':                'Tushum',
            'pos.extraProfit':            'Qoʻshimcha foyda',
            'pos.syncStatus':             'POS sinxronlash holati',
            'pos.synced':                 'Sinxronlandi',
            'pos.syncing':                'Sinxronlanmoqda',
            'pos.syncingCount':           'Sinxronlanmoqda ({count})...',
            'pos.offline':                'Oflayn',
            'pos.offlineCount':           'Oflayn ({count})',
            'pos.syncIssues':             '{count} ta sinxronlash xatosi',
            'pos.saved':                  'Saqlandi',
            'pos.syncFailed':             'Sinxronlashda xato',
            'pos.searchPlaceholder':      'Mahsulot yoki SKU qidirish...',
            'pos.filterAll':              'Barcha tovarlar',
            'pos.filterInStock':          'Mavjud',
            'pos.filterLowStock':         'Kam qolgan',
            'pos.productCount':           '{count} ta tovar',
            'pos.viewGrid':               'Katakcha',
            'pos.viewList':               'Roʻyxat',
            'pos.lowStockBadge':          'Kam qolgan',
            'pos.outOfStockBadge':        'Tugagan',
            'pos.newBadge':               'Yangi',
            'pos.untracked':              'hisobsiz',
            'pos.inStock':                'mavjud',
            'pos.recordSale':             'Sotuvni kiritish',
            'pos.recordSaleTitle':        'Sotuvni kiritish',
            'pos.quantity':               'Miqdor',
            'pos.onlyItemsAvailable':     'Faqat {max} dona mavjud.',
            'pos.sellingPrice':           'Sotish narxi (dona uchun, ming soʻmda)',
            'pos.thousandSum':            'ming soʻm',
            'pos.basePrice':              'Boshlangʻich katalog narxi',
            'pos.totalBaseValue':         'Boshlangʻich jami qiymat',
            'pos.unitSellingPrice':       'Dona sotish narxi',
            'pos.totalSaleAmount':        'Jami sotuv summasi',
            'pos.atBasePrice':            'Katalog narxida',
            'pos.enterSellingPrice':      'Sotish narxini kiriting',
            'pos.discount':               'Chegirma / arzonlashtirish',
            'pos.cancel':                 'Bekor qilish',
            'pos.confirmSale':            'Sotuvni tasdiqlash',
            'pos.saving':                 'Saqlanmoqda…',
            'pos.emptyCatalogTitle':      'Katalogda tovarlar yoʻq',
            'pos.emptyCatalogSub':        'Savdoni boshlash uchun avval Admin panelida tovarlar qoʻshing.',
            'pos.openAdmin':              'Admin panelini ochish',
            'pos.noMatchTitle':           'Mos tovarlar topilmadi',
            'pos.noMatchSub':             'Qidiruv soʻzini yoki filtrlarni oʻzgartirib koʻring.',
            'pos.toastNewProduct':        'Yangi tovar qoʻshildi: {name}',
            'pos.toastUpdatedProduct':    'Tovar yangilandi: {name}',
            'pos.toastRemovedProduct':    'Tovar katalogdan oʻchirildi',
            'pos.toastValidQty':          'Toʻgʻri miqdorni kiriting.',
            'pos.toastStockLimit':        'Omborda faqat {stock} dona tovar bor.',
            'pos.toastValidPrice':        'Toʻgʻri sotish narxini kiriting.',
            'pos.toastSaleSuccess':       '{name} × {qty} · Sotildi: {total}',
            'pos.toastSoldAtBase':        'Katalog narxida sotildi',
            'pos.toastExtraProfit':       'Qoʻshimcha foyda: +{amount}',
            'pos.toastDiscount':          'Chegirma: −{amount}',
            'pos.toastInsufficientStock': '🚨 Sotuv rad etildi: serverda yetarli tovar yoʻq.'
        }
    };

    // Aliases — accept 3-letter ISO codes too (eng, rus, uzb)
    var ALIASES = { eng: 'en', rus: 'ru', uzb: 'uz' };

    /* ------------------------------------------------------------------
       RUNTIME
       ------------------------------------------------------------------ */
    function normalize(code) {
        if (!code) return null;
        code = String(code).toLowerCase();
        if (dict[code]) return code;
        if (ALIASES[code]) return ALIASES[code];
        var base = code.slice(0, 2);
        return dict[base] ? base : null;
    }

    function detectLang() {
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            var match = normalize(saved);
            if (match) return match;
        } catch (e) { /* storage may be blocked */ }
        var nav = (navigator.language || navigator.userLanguage || 'en');
        return normalize(nav) || 'en';
    }

    var current = detectLang();

    function t(key, params) {
        var table = dict[current] || dict.en;
        var value = table[key];
        if (value == null) value = (dict.en[key] != null ? dict.en[key] : key);
        if (params && typeof value === 'string') {
            value = value.replace(/\{(\w+)\}/g, function (m, name) {
                return params[name] != null ? params[name] : m;
            });
        }
        return value;
    }

    function setLang(code) {
        var next = normalize(code);
        if (!next) return false;
        current = next;
        try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
        document.documentElement.setAttribute('lang', next);
        document.documentElement.setAttribute('data-lang', next);
        applyDom();
        document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: next } }));
        return true;
    }

    function getLang() { return current; }

    /**
     * Translate any element marked with:
     *   data-i18n              → textContent
     *   data-i18n-html         → innerHTML (use only for trusted keys)
     *   data-i18n-placeholder  → placeholder attribute
     *   data-i18n-title        → title attribute
     *   data-i18n-aria-label   → aria-label attribute
     *   data-i18n-value        → value attribute (for buttons, inputs)
     */
    function applyDom(root) {
        root = root || document;
        var apply = function (selector, fn) {
            var nodes = root.querySelectorAll(selector);
            for (var i = 0; i < nodes.length; i++) fn(nodes[i]);
        };
        apply('[data-i18n]',             function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
        apply('[data-i18n-html]',        function (el) { el.innerHTML   = t(el.getAttribute('data-i18n-html')); });
        apply('[data-i18n-placeholder]', function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
        apply('[data-i18n-title]',       function (el) { el.setAttribute('title',       t(el.getAttribute('data-i18n-title'))); });
        apply('[data-i18n-aria-label]',  function (el) { el.setAttribute('aria-label',  t(el.getAttribute('data-i18n-aria-label'))); });
        apply('[data-i18n-value]',       function (el) { el.setAttribute('value',       t(el.getAttribute('data-i18n-value'))); });
    }

    // Apply initial <html lang="..."> right away
    document.documentElement.setAttribute('lang', current);
    document.documentElement.setAttribute('data-lang', current);

    // Public API
    window.i18n = {
        t:          t,
        setLang:    setLang,
        getLang:    getLang,
        applyDom:   applyDom,
        langs:      langs,
        dict:       dict,
        STORAGE_KEY: STORAGE_KEY
    };

    // Auto-apply once the DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { applyDom(); });
    } else {
        applyDom();
    }
})();
