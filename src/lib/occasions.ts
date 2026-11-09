// Occasion engine: festivals, holidays and personal occasions with dates, templates and e-card themes.
// Shared by the server (validation, e-cards) and the browser (picker, upcoming detector).
//
// Dates: fixed-date occasions are exact; Easter and Thanksgiving are calculated. Festivals that follow
// lunar calendars (Diwali, Holi, Eid…) move every year and can differ by a day between regions, so their
// dates are a best-effort table marked `approximate` — the UI asks people to check before scheduling.

export type OccasionCategory = 'indian' | 'global' | 'national' | 'personal';
export type TemplateLanguage = 'en' | 'hi' | 'hinglish';
export type CardMotif =
  | 'diyas'
  | 'splashes'
  | 'fireworks'
  | 'bells'
  | 'kites'
  | 'tricolor'
  | 'moon'
  | 'flowers'
  | 'leaves'
  | 'balloons'
  | 'hearts'
  | 'mandala'
  | 'confetti';

type DateRule =
  | { kind: 'fixed'; month: number; day: number }
  | { kind: 'table'; dates: string[] }
  | { kind: 'easter' }
  | { kind: 'thanksgiving' };

export interface Occasion {
  id: string;
  name: string;
  emoji: string;
  category: OccasionCategory;
  /** null for personal occasions that have no calendar date */
  date: DateRule | null;
  card: {
    motif: CardMotif;
    /** [background top, background bottom, accent, text] */
    palette: [string, string, string, string];
    title: Record<'en' | 'hi', string>;
  };
  templates: Record<TemplateLanguage, string>;
}

export const LANGUAGE_LABELS: Record<TemplateLanguage, string> = { en: 'English', hi: 'हिन्दी', hinglish: 'Hinglish' };
export const CATEGORY_LABELS: Record<OccasionCategory, string> = {
  indian: 'Indian festivals',
  global: 'Global & religious',
  national: 'National days',
  personal: 'Personal occasions',
};

export const OCCASIONS: Occasion[] = [
  // ---------------------------------------------------------------- Indian festivals
  {
    id: 'diwali',
    name: 'Diwali',
    emoji: '🪔',
    category: 'indian',
    date: { kind: 'table', dates: ['2026-11-08', '2027-10-29', '2028-10-17'] },
    card: { motif: 'diyas', palette: ['#3b0d0c', '#7a1f0f', '#ffb347', '#fff4e0'], title: { en: 'Happy Diwali', hi: 'शुभ दीपावली' } },
    templates: {
      en: `{Happy Diwali|Wishing you a joyful Diwali|Warm Diwali greetings}, {{first_name}}! 🪔

{May the festival of lights|May the glow of a thousand diyas} bring {joy, prosperity and good health|happiness and success|peace and prosperity} to you and your family. ✨

{With love|Warm regards|Best wishes} 🙏`,
      hi: `{दीपावली की हार्दिक शुभकामनाएँ|शुभ दीपावली|आपको दिवाली की ढेर सारी शुभकामनाएँ}, {{first_name}}! 🪔

{दीपों का यह पर्व|माँ लक्ष्मी की कृपा से यह दिवाली} आपके जीवन में {सुख, समृद्धि और खुशियाँ|प्रकाश और आनंद|ढेर सारी खुशियाँ} लेकर आए। ✨

{सप्रेम|शुभकामनाओं सहित} 🙏`,
      hinglish: `{Happy Diwali|Diwali ki dher saari shubhkamnayein|Shubh Deepawali}, {{first_name}}! 🪔

{Yeh roshni ka tyohaar|Maa Lakshmi ki kripa se yeh Diwali} aapke ghar {khushiyan aur samriddhi|sukh aur shanti|dher saari khushiyan} laaye. ✨

{Bahut saara pyaar|Best wishes} 🙏`,
    },
  },
  {
    id: 'holi',
    name: 'Holi',
    emoji: '🎨',
    category: 'indian',
    date: { kind: 'table', dates: ['2026-03-04', '2027-03-22', '2028-03-11'] },
    card: { motif: 'splashes', palette: ['#fff6fb', '#fde7f3', '#e91e63', '#4a1238'], title: { en: 'Happy Holi', hi: 'होली मुबारक' } },
    templates: {
      en: `{Happy Holi|Wishing you a colourful Holi|Warm Holi wishes}, {{first_name}}! 🎨

May {every colour of Holi|this festival of colours} fill your life with {joy, love and laughter|happiness and good vibes|fun and friendship}. 🌈

{Stay safe and have fun|Enjoy every moment}! 💐`,
      hi: `{होली की हार्दिक शुभकामनाएँ|होली मुबारक|रंगों भरी होली की बधाई}, {{first_name}}! 🎨

{रंगों का यह त्योहार|यह होली} आपके जीवन में {खुशियों के रंग|प्रेम और उल्लास|ढेर सारी मुस्कान} भर दे। 🌈

{सप्रेम|शुभकामनाओं सहित} 💐`,
      hinglish: `{Happy Holi|Holi Mubarak|Rang bhari Holi ki badhai}, {{first_name}}! 🎨

{Yeh rangon ka tyohaar|Yeh Holi} aapki life mein {khushiyon ke rang|pyaar aur masti|dher saari smiles} bhar de. 🌈

{Masti karo, safe raho|Enjoy karo}! 💐`,
    },
  },
  {
    id: 'raksha-bandhan',
    name: 'Raksha Bandhan',
    emoji: '🧵',
    category: 'indian',
    date: { kind: 'table', dates: ['2026-08-28', '2027-08-17', '2028-08-05'] },
    card: { motif: 'flowers', palette: ['#fff8ef', '#ffe6cc', '#d9480f', '#5c2a0b'], title: { en: 'Happy Raksha Bandhan', hi: 'रक्षाबंधन की शुभकामनाएँ' } },
    templates: {
      en: `{Happy Raksha Bandhan|Warm Rakhi wishes|Happy Rakhi}, {{first_name}}! 🧵

May {this sacred thread|the bond of Rakhi} {keep us close forever|bring you love, protection and joy|grow stronger every year}. 💛

{With love|Lots of love} 🙏`,
      hi: `{रक्षाबंधन की हार्दिक शुभकामनाएँ|राखी की बधाई|हैप्पी रक्षाबंधन}, {{first_name}}! 🧵

{यह पवित्र धागा|राखी का यह बंधन} {हमारे रिश्ते को और मज़बूत करे|आपको सदा खुश रखे|हर साल और गहरा हो}। 💛

{सप्रेम|ढेर सारा प्यार} 🙏`,
      hinglish: `{Happy Raksha Bandhan|Rakhi ki dher saari badhai|Happy Rakhi}, {{first_name}}! 🧵

{Yeh pyaara dhaaga|Rakhi ka yeh bandhan} {humesha humein kareeb rakhe|aapko khushiyan de|har saal aur strong ho}. 💛

{Bahut saara pyaar|Lots of love} 🙏`,
    },
  },
  {
    id: 'janmashtami',
    name: 'Janmashtami',
    emoji: '🪈',
    category: 'indian',
    date: { kind: 'table', dates: ['2026-09-04', '2027-08-25', '2028-08-13'] },
    card: { motif: 'mandala', palette: ['#0b1d4d', '#1d3b8a', '#f5c542', '#fdf6e3'], title: { en: 'Happy Janmashtami', hi: 'शुभ जन्माष्टमी' } },
    templates: {
      en: `{Happy Janmashtami|Warm Janmashtami wishes|Joyful Krishna Janmashtami}, {{first_name}}! 🪈

May {Lord Krishna|Shri Krishna} {bless you with love, joy and wisdom|fill your home with happiness|guide you always}. 🙏

{Jai Shri Krishna|Radhe Radhe}! 💙`,
      hi: `{जन्माष्टमी की हार्दिक शुभकामनाएँ|शुभ जन्माष्टमी|कृष्ण जन्मोत्सव की बधाई}, {{first_name}}! 🪈

{श्री कृष्ण|कान्हा जी} {आपके जीवन को प्रेम और आनंद से भर दें|आप पर सदा कृपा बनाए रखें|आपके घर खुशियाँ लाएँ}। 🙏

{जय श्री कृष्ण|राधे राधे}! 💙`,
      hinglish: `{Happy Janmashtami|Janmashtami ki hardik shubhkamnayein|Krishna Janmotsav ki badhai}, {{first_name}}! 🪈

{Shri Krishna|Kanha ji} {aapki life ko pyaar aur khushiyon se bhar dein|aap par hamesha kripa banaye rakhein}. 🙏

{Jai Shri Krishna|Radhe Radhe}! 💙`,
    },
  },
  {
    id: 'ganesh-chaturthi',
    name: 'Ganesh Chaturthi',
    emoji: '🐘',
    category: 'indian',
    date: { kind: 'table', dates: ['2026-09-14', '2027-09-04', '2028-08-23'] },
    card: { motif: 'mandala', palette: ['#fff4e6', '#ffd8a8', '#e8590c', '#5c1f00'], title: { en: 'Happy Ganesh Chaturthi', hi: 'गणेश चतुर्थी की शुभकामनाएँ' } },
    templates: {
      en: `{Happy Ganesh Chaturthi|Warm Ganesh Chaturthi wishes|Ganpati Bappa Morya}, {{first_name}}! 🐘

May {Lord Ganesha|Ganpati Bappa} {remove every obstacle from your path|bless you with wisdom and prosperity|bring success and happiness to your home}. 🌺

{Ganpati Bappa Morya|Best wishes} 🙏`,
      hi: `{गणेश चतुर्थी की हार्दिक शुभकामनाएँ|गणपति बप्पा मोरया|विनायक चतुर्थी की बधाई}, {{first_name}}! 🐘

{श्री गणेश|गणपति बप्पा} {आपके सभी विघ्न दूर करें|आपको सुख, समृद्धि और बुद्धि दें|आपके घर खुशियाँ लाएँ}। 🌺

{गणपति बप्पा मोरया|शुभकामनाओं सहित} 🙏`,
      hinglish: `{Happy Ganesh Chaturthi|Ganesh Chaturthi ki hardik shubhkamnayein|Ganpati Bappa Morya}, {{first_name}}! 🐘

{Ganpati Bappa|Shri Ganesh} {aapke saare vighn door karein|aapko sukh aur samriddhi dein|aapke ghar khushiyan laayein}. 🌺

{Ganpati Bappa Morya|Best wishes} 🙏`,
    },
  },
  {
    id: 'navratri',
    name: 'Navratri',
    emoji: '🪷',
    category: 'indian',
    date: { kind: 'table', dates: ['2026-10-11', '2027-09-30', '2028-09-19'] },
    card: { motif: 'mandala', palette: ['#4a0d2a', '#8f1d4f', '#ffc107', '#fff3e0'], title: { en: 'Happy Navratri', hi: 'शुभ नवरात्रि' } },
    templates: {
      en: `{Happy Navratri|Warm Navratri wishes|Blessed Navratri}, {{first_name}}! 🪷

May {Maa Durga|the nine nights of the Goddess} {bless you with strength, joy and prosperity|fill your life with positivity|protect you and your family}. ✨

{Jai Mata Di|Best wishes} 🙏`,
      hi: `{नवरात्रि की हार्दिक शुभकामनाएँ|शुभ नवरात्रि|नवरात्रि की बधाई}, {{first_name}}! 🪷

{माँ दुर्गा|माता रानी} {आपको शक्ति, सुख और समृद्धि दें|आपके जीवन में उजाला भर दें|आपके परिवार की रक्षा करें}। ✨

{जय माता दी|शुभकामनाओं सहित} 🙏`,
      hinglish: `{Happy Navratri|Navratri ki hardik shubhkamnayein|Shubh Navratri}, {{first_name}}! 🪷

{Maa Durga|Mata Rani} {aapko shakti aur khushiyan dein|aapki life mein positivity bhar dein}. ✨

{Jai Mata Di|Best wishes} 🙏`,
    },
  },
  {
    id: 'dussehra',
    name: 'Dussehra',
    emoji: '🏹',
    category: 'indian',
    date: { kind: 'table', dates: ['2026-10-20', '2027-10-09', '2028-09-27'] },
    card: { motif: 'fireworks', palette: ['#2b0a0a', '#6b1414', '#ff9800', '#fff3e0'], title: { en: 'Happy Dussehra', hi: 'विजयादशमी की शुभकामनाएँ' } },
    templates: {
      en: `{Happy Dussehra|Warm Vijayadashami wishes|Happy Vijayadashami}, {{first_name}}! 🏹

May {the victory of good over evil|this Dussehra} {inspire you|bring you success in everything you do|fill your life with positivity}. 🔥

{Best wishes|Warm regards} 🙏`,
      hi: `{दशहरा की हार्दिक शुभकामनाएँ|विजयादशमी की बधाई|शुभ दशहरा}, {{first_name}}! 🏹

{बुराई पर अच्छाई की जीत का यह पर्व|यह विजयादशमी} {आपको हर कार्य में सफलता दे|आपके जीवन में नई ऊर्जा भर दे}। 🔥

{शुभकामनाओं सहित|सप्रेम} 🙏`,
      hinglish: `{Happy Dussehra|Vijayadashami ki badhai|Dussehra ki hardik shubhkamnayein}, {{first_name}}! 🏹

{Buraai par acchhai ki jeet ka yeh tyohaar|Yeh Dussehra} {aapko har kaam mein success de|aapki life mein nayi energy bhar de}. 🔥

{Best wishes|Shubhkamnayein} 🙏`,
    },
  },
  {
    id: 'makar-sankranti',
    name: 'Makar Sankranti',
    emoji: '🪁',
    category: 'indian',
    date: { kind: 'table', dates: ['2026-01-14', '2027-01-15', '2028-01-15'] },
    card: { motif: 'kites', palette: ['#e3f6ff', '#b8e4ff', '#ff6b35', '#0b3954'], title: { en: 'Happy Makar Sankranti', hi: 'मकर संक्रांति की शुभकामनाएँ' } },
    templates: {
      en: `{Happy Makar Sankranti|Warm Sankranti wishes|Happy Uttarayan}, {{first_name}}! 🪁

May {your kite fly high|this harvest festival} {and bring you sweet success|fill your year with sunshine and joy|bring prosperity to your home}. ☀️

{Til-gul ghya, god god bola|Best wishes}! 🙏`,
      hi: `{मकर संक्रांति की हार्दिक शुभकामनाएँ|हैप्पी मकर संक्रांति|संक्रांति की बधाई}, {{first_name}}! 🪁

{आपकी पतंग की तरह|इस पावन पर्व पर} {आपकी सफलता भी ऊँची उड़ान भरे|आपके जीवन में मिठास और खुशियाँ आएँ}। ☀️

{शुभकामनाओं सहित|सप्रेम} 🙏`,
      hinglish: `{Happy Makar Sankranti|Sankranti ki hardik shubhkamnayein|Happy Uttarayan}, {{first_name}}! 🪁

{Aapki patang ki tarah|Is tyohaar par} {aapki success bhi oonchi udaan bhare|aapki life mein mithaas aur khushiyan aayein}. ☀️

{Best wishes|Shubhkamnayein} 🙏`,
    },
  },
  // ---------------------------------------------------------------- Global & religious
  {
    id: 'new-year',
    name: 'New Year',
    emoji: '🎆',
    category: 'global',
    date: { kind: 'fixed', month: 1, day: 1 },
    card: { motif: 'fireworks', palette: ['#0b0b2b', '#1c1c5a', '#ffd166', '#ffffff'], title: { en: 'Happy New Year', hi: 'नव वर्ष की शुभकामनाएँ' } },
    templates: {
      en: `{Happy New Year|Wishing you a wonderful New Year|Cheers to the New Year}, {{first_name}}! 🎆

May {the year ahead|this new year} {bring you health, happiness and success|be full of new adventures|be your best one yet}. ✨

{Warm wishes|Best wishes|Cheers} 🥂`,
      hi: `{नव वर्ष की हार्दिक शुभकामनाएँ|नया साल मुबारक|हैप्पी न्यू ईयर}, {{first_name}}! 🎆

{आने वाला साल|यह नया वर्ष} {आपके लिए सेहत, खुशियाँ और सफलता लेकर आए|आपके सभी सपने पूरे करे}। ✨

{शुभकामनाओं सहित|सप्रेम} 🥂`,
      hinglish: `{Happy New Year|Naya saal mubarak|Wishing you a superb New Year}, {{first_name}}! 🎆

{Aane wala saal|Yeh naya saal} {aapke liye health, khushiyan aur success laaye|aapke saare sapne poore kare}. ✨

{Best wishes|Cheers} 🥂`,
    },
  },
  {
    id: 'christmas',
    name: 'Christmas',
    emoji: '🎄',
    category: 'global',
    date: { kind: 'fixed', month: 12, day: 25 },
    card: { motif: 'bells', palette: ['#0f3d2e', '#14532d', '#e63946', '#fdf6e3'], title: { en: 'Merry Christmas', hi: 'मेरी क्रिसमस' } },
    templates: {
      en: `{Merry Christmas|Season's greetings|Warm Christmas wishes}, {{first_name}}! 🎄

May {your holidays|this festive season} {be merry and bright|be filled with love, peace and joy|bring you closer to the people you love}. ✨

{Happy holidays|With warm wishes} 🎁`,
      hi: `{क्रिसमस की हार्दिक शुभकामनाएँ|मेरी क्रिसमस|बड़े दिन की बधाई}, {{first_name}}! 🎄

{यह त्योहार|क्रिसमस का यह मौसम} {आपके जीवन में प्रेम, शांति और खुशियाँ लाए|आपके परिवार को सदा खुश रखे}। ✨

{शुभकामनाओं सहित|सप्रेम} 🎁`,
      hinglish: `{Merry Christmas|Christmas ki dher saari badhai|Happy Christmas}, {{first_name}}! 🎄

{Yeh festive season|Yeh Christmas} {aapki life mein pyaar, shanti aur khushiyan laaye|aapke family ko hamesha khush rakhe}. ✨

{Happy holidays|Best wishes} 🎁`,
    },
  },
  {
    id: 'easter',
    name: 'Easter',
    emoji: '🐣',
    category: 'global',
    date: { kind: 'easter' },
    card: { motif: 'flowers', palette: ['#f4fff1', '#e2f5d8', '#ff8fab', '#2f4f2f'], title: { en: 'Happy Easter', hi: 'ईस्टर की शुभकामनाएँ' } },
    templates: {
      en: `{Happy Easter|Wishing you a joyful Easter|Blessed Easter}, {{first_name}}! 🐣

May {this season of new beginnings|Easter} {fill your heart with hope and joy|bring peace and happiness to your home}. 🌷

{Warm wishes|With love} 🙏`,
      hi: `{ईस्टर की हार्दिक शुभकामनाएँ|हैप्पी ईस्टर}, {{first_name}}! 🐣

{नई शुरुआत का यह पर्व|यह ईस्टर} {आपके मन को आशा और आनंद से भर दे|आपके घर में सुख-शांति लाए}। 🌷

{शुभकामनाओं सहित|सप्रेम} 🙏`,
      hinglish: `{Happy Easter|Easter ki dher saari shubhkamnayein}, {{first_name}}! 🐣

{Yeh nayi shuruaat ka tyohaar|Yeh Easter} {aapke dil ko umeed aur khushi se bhar de|aapke ghar sukh-shanti laaye}. 🌷

{Best wishes|With love} 🙏`,
    },
  },
  {
    id: 'thanksgiving',
    name: 'Thanksgiving',
    emoji: '🦃',
    category: 'global',
    date: { kind: 'thanksgiving' },
    card: { motif: 'leaves', palette: ['#fff6e9', '#ffe1bf', '#c2410c', '#4a2511'], title: { en: 'Happy Thanksgiving', hi: 'थैंक्सगिविंग की शुभकामनाएँ' } },
    templates: {
      en: `{Happy Thanksgiving|Warm Thanksgiving wishes}, {{first_name}}! 🦃

{I'm so thankful for you|Grateful to have you in my life}. May your {table be full|day be filled with warmth, love and good food}. 🍂

{With gratitude|Warm wishes} 🙏`,
      hi: `{थैंक्सगिविंग की हार्दिक शुभकामनाएँ|हैप्पी थैंक्सगिविंग}, {{first_name}}! 🦃

{आपका मेरे जीवन में होना|आपका साथ} {मेरे लिए बहुत अनमोल है|किसी आशीर्वाद से कम नहीं}। 🍂

{आभार सहित|सप्रेम} 🙏`,
      hinglish: `{Happy Thanksgiving|Thanksgiving ki badhai}, {{first_name}}! 🦃

{Aap meri life mein ho, iske liye bahut thankful hoon|Aapka saath bahut anmol hai}. 🍂

{With gratitude|Best wishes} 🙏`,
    },
  },
  {
    id: 'eid-ul-fitr',
    name: 'Eid ul-Fitr',
    emoji: '🌙',
    category: 'global',
    date: { kind: 'table', dates: ['2026-03-20', '2027-03-10', '2028-02-27'] },
    card: { motif: 'moon', palette: ['#06283d', '#0b4a6e', '#f4d35e', '#fdfcf6'], title: { en: 'Eid Mubarak', hi: 'ईद मुबारक' } },
    templates: {
      en: `{Eid Mubarak|Warm Eid wishes|Happy Eid}, {{first_name}}! 🌙

May {this blessed day|Allah's blessings} {fill your home with peace, joy and prosperity|bring you happiness and success}. ✨

{Eid Mubarak|With warm wishes} 🤲`,
      hi: `{ईद मुबारक|ईद की दिली मुबारकबाद}, {{first_name}}! 🌙

{यह मुबारक दिन|ईद का यह त्योहार} {आपके घर में अमन, खुशियाँ और बरकत लाए|आपकी हर दुआ कबूल करे}। ✨

{ईद मुबारक|दिली मुबारकबाद} 🤲`,
      hinglish: `{Eid Mubarak|Eid ki dili mubarakbaad}, {{first_name}}! 🌙

{Yeh mubarak din|Eid ka yeh tyohaar} {aapke ghar aman, khushiyan aur barkat laaye|aapki har dua qubool kare}. ✨

{Eid Mubarak|Best wishes} 🤲`,
    },
  },
  {
    id: 'eid-ul-adha',
    name: 'Eid ul-Adha (Bakrid)',
    emoji: '🌙',
    category: 'global',
    date: { kind: 'table', dates: ['2026-05-27', '2027-05-17', '2028-05-05'] },
    card: { motif: 'moon', palette: ['#0e2f1f', '#145a3a', '#f4d35e', '#fdfcf6'], title: { en: 'Eid al-Adha Mubarak', hi: 'ईद-उल-अज़हा मुबारक' } },
    templates: {
      en: `{Eid al-Adha Mubarak|Warm Bakrid wishes|Happy Eid al-Adha}, {{first_name}}! 🌙

May {this blessed occasion|Allah's blessings} {bring peace, happiness and prosperity to you and your family|accept your prayers and sacrifices}. ✨

{Eid Mubarak|With warm wishes} 🤲`,
      hi: `{ईद-उल-अज़हा मुबारक|बकरीद की दिली मुबारकबाद}, {{first_name}}! 🌙

{यह मुबारक मौका|अल्लाह की रहमत} {आपके परिवार में अमन और खुशियाँ लाए|आपकी हर दुआ कबूल करे}। ✨

{ईद मुबारक|दिली मुबारकबाद} 🤲`,
      hinglish: `{Eid al-Adha Mubarak|Bakrid ki dili mubarakbaad}, {{first_name}}! 🌙

{Yeh mubarak mauka|Allah ki rehmat} {aapke parivaar mein aman aur khushiyan laaye|aapki har dua qubool kare}. ✨

{Eid Mubarak|Best wishes} 🤲`,
    },
  },
  // ---------------------------------------------------------------- National days (India)
  {
    id: 'republic-day',
    name: 'Republic Day',
    emoji: '🇮🇳',
    category: 'national',
    date: { kind: 'fixed', month: 1, day: 26 },
    card: { motif: 'tricolor', palette: ['#ffffff', '#f1f5f9', '#000080', '#1e293b'], title: { en: 'Happy Republic Day', hi: 'गणतंत्र दिवस की शुभकामनाएँ' } },
    templates: {
      en: `{Happy Republic Day|Warm Republic Day wishes}, {{first_name}}! 🇮🇳

{Let's celebrate the spirit of our Constitution|Proud to be Indian today and always}. May {our nation|India} {keep growing stronger|shine brighter every year}. 🙏

{Jai Hind|Vande Mataram}!`,
      hi: `{गणतंत्र दिवस की हार्दिक शुभकामनाएँ|हैप्पी रिपब्लिक डे}, {{first_name}}! 🇮🇳

{आइए संविधान के गौरव का उत्सव मनाएँ|भारतीय होने पर गर्व है}। {हमारा देश|भारत} {सदा प्रगति करता रहे|हर साल और ऊँचाइयाँ छुए}। 🙏

{जय हिन्द|वंदे मातरम}!`,
      hinglish: `{Happy Republic Day|Gantantra Diwas ki hardik shubhkamnayein}, {{first_name}}! 🇮🇳

{Proud to be Indian|Samvidhan ke gaurav ko salaam}. {Hamara desh|India} {hamesha aage badhta rahe|har saal aur chamke}. 🙏

{Jai Hind|Vande Mataram}!`,
    },
  },
  {
    id: 'independence-day',
    name: 'Independence Day',
    emoji: '🇮🇳',
    category: 'national',
    date: { kind: 'fixed', month: 8, day: 15 },
    card: { motif: 'tricolor', palette: ['#ffffff', '#f1f5f9', '#000080', '#1e293b'], title: { en: 'Happy Independence Day', hi: 'स्वतंत्रता दिवस की शुभकामनाएँ' } },
    templates: {
      en: `{Happy Independence Day|Warm Independence Day wishes}, {{first_name}}! 🇮🇳

{Let's honour the freedom fighters who gave us this day|Proud of our freedom and our country}. May {India|our nation} {soar even higher|keep shining}. 🙏

{Jai Hind|Vande Mataram}!`,
      hi: `{स्वतंत्रता दिवस की हार्दिक शुभकामनाएँ|हैप्पी इंडिपेंडेंस डे}, {{first_name}}! 🇮🇳

{आज़ादी के वीरों को नमन|हमें अपनी आज़ादी पर गर्व है}। {भारत|हमारा देश} {और ऊँचाइयाँ छुए|सदा चमकता रहे}। 🙏

{जय हिन्द|वंदे मातरम}!`,
      hinglish: `{Happy Independence Day|Swatantrata Diwas ki hardik shubhkamnayein}, {{first_name}}! 🇮🇳

{Azaadi ke veeron ko salaam|Proud of our freedom}. {India|Hamara desh} {aur oonchaiyan chhuye|hamesha chamakta rahe}. 🙏

{Jai Hind|Vande Mataram}!`,
    },
  },
  // ---------------------------------------------------------------- Personal occasions
  {
    id: 'birthday',
    name: 'Birthday',
    emoji: '🎂',
    category: 'personal',
    date: null,
    card: { motif: 'balloons', palette: ['#fff7ed', '#ffedd5', '#f43f5e', '#431407'], title: { en: 'Happy Birthday', hi: 'जन्मदिन मुबारक' } },
    templates: {
      en: `{Happy Birthday|Many happy returns of the day|Wishing you a fantastic birthday}, {{first_name}}! 🎂

May {the year ahead|this new chapter} {bring you joy, good health and success|be full of laughter and great memories}. 🎉

{Have an amazing day|Enjoy your special day}! 🎈`,
      hi: `{जन्मदिन की हार्दिक शुभकामनाएँ|जन्मदिन मुबारक|हैप्पी बर्थडे}, {{first_name}}! 🎂

{आने वाला साल|आपका यह नया साल} {आपके लिए सेहत, खुशियाँ और सफलता लाए|हँसी और यादगार पलों से भरा हो}। 🎉

{आपका दिन शानदार हो|ढेर सारा प्यार}! 🎈`,
      hinglish: `{Happy Birthday|Janamdin mubarak|Many happy returns}, {{first_name}}! 🎂

{Aane wala saal|Yeh naya saal} {aapke liye health, khushiyan aur success laaye|hansi aur yaadgaar pal laaye}. 🎉

{Have a superb day|Party hard}! 🎈`,
    },
  },
  {
    id: 'anniversary',
    name: 'Anniversary',
    emoji: '💞',
    category: 'personal',
    date: null,
    card: { motif: 'hearts', palette: ['#fff1f2', '#ffe4e6', '#e11d48', '#4c0519'], title: { en: 'Happy Anniversary', hi: 'सालगिरह मुबारक' } },
    templates: {
      en: `{Happy Anniversary|Warm anniversary wishes|Congratulations on your anniversary}, {{first_name}}! 💞

May {your love|your journey together} {keep growing stronger every year|be filled with happiness and laughter}. 🌹

{With love|Best wishes}`,
      hi: `{सालगिरह की हार्दिक शुभकामनाएँ|शादी की सालगिरह मुबारक|हैप्पी एनिवर्सरी}, {{first_name}}! 💞

{आपका प्यार|आपका साथ} {हर साल और गहरा हो|सदा खुशियों से भरा रहे}। 🌹

{सप्रेम|शुभकामनाओं सहित}`,
      hinglish: `{Happy Anniversary|Saalgirah mubarak|Shaadi ki saalgirah ki badhai}, {{first_name}}! 💞

{Aapka pyaar|Aapka saath} {har saal aur strong ho|hamesha khushiyon se bhara rahe}. 🌹

{With love|Best wishes}`,
    },
  },
  {
    id: 'wedding-invite',
    name: 'Wedding Invitation',
    emoji: '💍',
    category: 'personal',
    date: null,
    card: { motif: 'flowers', palette: ['#fffaf0', '#fdecc8', '#b5179e', '#3c096c'], title: { en: "You're Invited", hi: 'शुभ विवाह' } },
    templates: {
      en: `{Dear|Hello} {{first_name}}, 💍

{We would be delighted|It would mean a lot to us} {if you could join us|to have you with us} for the wedding celebrations. {Details are below|Please save the date}:

📅 [date]  📍 [venue]

{Looking forward to celebrating with you|Your presence will make the day special}! 🙏`,
      hi: `{प्रिय|नमस्ते} {{first_name}}, 💍

{आपको सपरिवार सादर आमंत्रित करते हुए हमें अत्यंत हर्ष हो रहा है|आपकी उपस्थिति हमारे लिए बहुत मायने रखती है}। विवाह समारोह का विवरण:

📅 [तिथि]  📍 [स्थान]

{आपकी प्रतीक्षा रहेगी|कृपया पधारकर आशीर्वाद दें}! 🙏`,
      hinglish: `{Dear|Namaste} {{first_name}}, 💍

{Aapko sapariwaar shaadi mein aamantrit karte hue humein bahut khushi ho rahi hai|Aapka aana humare liye bahut special hoga}. Details:

📅 [date]  📍 [venue]

{Zaroor aaiyega|Aapka intezaar rahega}! 🙏`,
    },
  },
  {
    id: 'announcement',
    name: 'General Announcement',
    emoji: '📢',
    category: 'personal',
    date: null,
    card: { motif: 'confetti', palette: ['#f8fafc', '#e2e8f0', '#6366f1', '#0f172a'], title: { en: 'Big News!', hi: 'खुशखबरी!' } },
    templates: {
      en: `{Hi|Hello} {{first_name}}! 📢

{I have some news to share|Quick update from my side}: [your news here].

{Thank you|Cheers}! 🙏`,
      hi: `{नमस्ते|प्रिय} {{first_name}}! 📢

{आपसे एक खुशखबरी साझा करनी है|एक ज़रूरी सूचना}: [अपनी बात यहाँ लिखें]।

{धन्यवाद|सप्रेम} 🙏`,
      hinglish: `{Hi|Namaste} {{first_name}}! 📢

{Ek khushkhabri share karni thi|Ek quick update}: [apni baat yahan likhein].

{Thank you|Cheers}! 🙏`,
    },
  },
];

const BY_ID = new Map(OCCASIONS.map((o) => [o.id, o]));

export function getOccasion(id: string | null | undefined): Occasion | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

export function isOccasionId(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value);
}

// ---- Dates -------------------------------------------------------------------------------

/** Western Easter Sunday (Anonymous Gregorian algorithm). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/** US Thanksgiving: fourth Thursday of November. */
function thanksgiving(year: number): Date {
  const firstOfNov = new Date(year, 10, 1);
  const firstThursday = 1 + ((4 - firstOfNov.getDay() + 7) % 7);
  return new Date(year, 10, firstThursday + 21);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Next date on or after `from` (local time), or null when unknown / not dated. */
export function nextOccurrence(o: Occasion, from: Date = new Date()): { date: Date; approximate: boolean } | null {
  if (!o.date) return null;
  const today = startOfDay(from);
  const rule = o.date;
  for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
    let date: Date | null = null;
    if (rule.kind === 'fixed') date = new Date(year, rule.month - 1, rule.day);
    else if (rule.kind === 'easter') date = easterSunday(year);
    else if (rule.kind === 'thanksgiving') date = thanksgiving(year);
    else {
      const match = rule.dates.map(parseLocalDate).find((d) => d.getFullYear() === year && d >= today);
      date = match ?? null;
    }
    if (date && date >= today) return { date, approximate: rule.kind === 'table' };
  }
  return null;
}

export interface UpcomingOccasion {
  occasion: Occasion;
  date: Date;
  daysAway: number;
  approximate: boolean;
}

/** Dated occasions coming up, nearest first. */
export function upcomingOccasions(from: Date = new Date(), limit = 5): UpcomingOccasion[] {
  const today = startOfDay(from).getTime();
  return OCCASIONS.map((occasion) => {
    const next = nextOccurrence(occasion, from);
    return next
      ? { occasion, date: next.date, approximate: next.approximate, daysAway: Math.round((next.date.getTime() - today) / 86_400_000) }
      : null;
  })
    .filter((x): x is UpcomingOccasion => x !== null)
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, limit);
}

export function describeDaysAway(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}
