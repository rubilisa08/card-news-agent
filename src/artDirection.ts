import type { CardDesign } from './types.ts';

/**
 * Art direction for every generated card picture (DECISIONS B31). The picture's
 * size, colours and empty space must suit the card design the text will sit in, so
 * these rules are added to every image request, for agy and for the Claude SVG
 * fallback alike. The storyboard's imagePrompt only says what to show; this says
 * where, how big and in which colours.
 */

export const CANVAS = { width: 1080, height: 1350 };

/** Hex colours named in the storyboard's style guide, in order. */
export function paletteOf(styleGuide: string): string[] {
  return [...new Set(styleGuide.match(/#[0-9a-fA-F]{6}\b/g) ?? [])].map((h) => h.toUpperCase());
}

/** Where the text goes and what the picture must leave for it, per design. */
const LAYOUT: Record<CardDesign, string[]> = {
  basic: [
    '배경은 팔레트의 가장 밝은 색 한 가지로 평평하게 깐다.',
    '위쪽 40%(y 0~540)는 제목과 본문이 올라갈 자리다. 어떤 물체·무늬·그림자도 두지 않고 배경색만 둔다.',
    '피사체 묶음은 아래쪽 60%(y 600~1270) 안에, 가로 가운데에 둔다. 피사체 묶음의 폭은 화면 폭의 60~80%로 한다.',
  ],
  soft: [
    '배경은 팔레트의 가장 밝은 색 한 가지로 평평하게 깐다(앱이 그 위에 은은한 색을 덧입힌다).',
    '위쪽 40%(y 0~540)는 제목과 본문이 올라갈 자리다. 어떤 물체·무늬·그림자도 두지 않고 배경색만 둔다.',
    '피사체 묶음은 아래쪽 60%(y 600~1270) 안에, 가로 가운데에 둔다. 피사체 묶음의 폭은 화면 폭의 60~80%로 한다.',
  ],
  brief: [
    '앱은 이 그림을 크림색(#F5F2EA) 카드의 오른쪽 아래 정사각형 창(380×380, 카드 폭의 약 1/3)에 작게 넣고 왼쪽 위 모서리를 크게 둥글린다. 그림의 위아래 약 10%씩은 잘린다.',
    '그림 전체를 장면 하나로 끝까지 채운다(위쪽 40%를 비우는 규칙은 이 디자인에 없다). 바탕은 팔레트의 어두운 색에서 밝은 색으로 이어지는 그라데이션이나 단색으로 꽉 채운다.',
    '주인공 하나를 가운데(x 200~880, y 250~1100)에 크고 단순하게 둔다. 작게 보여도 알아볼 수 있게 굵은 형태로 그리고, 세밀한 무늬나 작은 요소는 피한다.',
    '얇은 선(등고선·격자·물결)으로 바탕에 은은한 결을 줄 수 있다. 강조색은 한 곳에만 쓴다.',
  ],
  news: [
    '앱은 이 그림의 가운데 띠(y 150~790, 1080×640)만 잘라 카드 위쪽에 보여 주고, 띠 아래쪽은 어두운 바탕으로 서서히 사라지게 한다.',
    '주인공과 중요한 요소는 모두 y 220~720 안에 둔다. y 150보다 위와 y 790보다 아래에는 잘려도 되는 배경만 둔다.',
    '가로로 넓게 펼쳐지는 장면(건물·거리·현장·사람들)으로, 주인공은 띠의 가운데 또는 왼쪽 2/3 지점에 둔다.',
    '전체 톤은 차분하고 약간 어둡게, 하늘이나 배경은 흐린 회청색 계열로 한다. 띠 아래쪽 1/4은 어두운 남색으로 자연스럽게 이어질 수 있게 어둡게 둔다.',
  ],
  cinema: [
    '그림 전체가 카드 바탕이 되는 영화 장면 같은 한 컷이다. 앱은 아래쪽만 어둡게 하고 왼쪽 아래에 짧은 흰 글자를 2~3줄 얹는다.',
    '아래쪽 40%(y 810~1350)는 글자 자리다. 그 부분은 땅·물·그림자·흐린 배경처럼 어둡고 단순하게 두고, 밝은 물체나 얼굴을 두지 않는다.',
    '주인공은 위쪽 60%(y 120~780) 안, 가운데나 오른쪽 1/3 지점에 둔다. 사람은 뒷모습·옆모습이나 멀리 있는 모습으로 하고 얼굴이 또렷한 실존 인물처럼 보이지 않게 한다.',
    '필름 사진 같은 톤: 채도를 조금 낮추고, 부드러운 자연광, 약한 입자감. 전체 밝기는 중간보다 약간 어둡게.',
  ],
  photo: [
    '그림 전체가 카드 바탕이 되고, 앱이 그 위를 어둡게 눌러 흰 글자를 얹는다.',
    '왼쪽 위 글자 자리(x 60~640, y 180~800)는 어둡고 단순하게 둔다. 그 자리에는 밝은 물체·글자판·복잡한 무늬를 두지 않고, 그림자나 흐린 배경만 둔다.',
    '주인공은 오른쪽 위(x 560~1020, y 150~600) 또는 아래쪽(y 900~1300)에 두고, 화면의 25~40%를 차지하게 한다.',
    '전체 밝기는 중간보다 어둡게, 주인공 한 곳에만 따뜻한 빛을 준다.',
  ],
};

const PHOTO_LIKE = new Set<CardDesign>(['news', 'photo', 'cinema']);

/** Photo-like for the photo designs; the style guide's look for the others. */
function look(design: CardDesign, tool: 'agy' | 'svg') {
  if (design === 'news' || design === 'photo' || design === 'cinema') {
    return tool === 'agy'
      ? '사진처럼 사실적인 장면(보도사진 느낌, 자연광, 얕은 심도)으로 그린다. 실존 인물·실제 브랜드·로고는 나오지 않게 한다.'
      : 'SVG라 사진은 못 그리므로, 겹겹의 실루엣과 부드러운 그라데이션으로 깊이감 있는 어두운 장면을 그린다.';
  }
  return '스토리보드의 공통 그림체를 그대로 따른다(플랫 일러스트, 단순한 도형, 얇은 윤곽선).';
}

/**
 * The rules added to every image request. `styleGuide` is the storyboard's common
 * look; its hex colours become the only colours allowed.
 */
export function artDirection(design: CardDesign, styleGuide: string, tool: 'agy' | 'svg'): string {
  const palette = paletteOf(styleGuide);
  const lines = [
    `[그림 규칙: 카드 디자인 "${design}"에 맞춘 크기·색·여백. 모든 카드에 똑같이 지킨다]`,
    `- 크기: 세로 ${CANVAS.width}×${CANVAS.height}(4:5). 이 비율을 바꾸거나 테두리를 두지 않는다.`,
    `- 그림체: ${look(design, tool)}`,
    // Photo-like designs keep natural colours, graded toward the palette.
    palette.length && PHOTO_LIKE.has(design)
      ? `- 색: 사진의 자연스러운 색은 그대로 두되, 전체 색 보정을 ${palette.join(', ')} 계열로 맞춰 모든 카드가 한 톤으로 보이게 한다. 튀는 원색은 피한다.`
      : palette.length
        ? `- 색: ${palette.join(', ')}만 쓰고, 이 색의 밝기만 조절한 색은 써도 된다. 한 장 안에서 강조색(${palette.at(-1)})은 한 곳에만 쓴다.`
        : '- 색: 3~4가지 색만 쓰고, 강조색은 한 곳에만 쓴다.',
    '- 여백: 화면 가장자리에서 80px 안쪽은 주인공이 잘리지 않게 비운다. 요소는 3개 이하로 단순하게 둔다.',
    ...LAYOUT[design].map((t) => `- ${t}`),
    '- 그림 안에 글자·숫자·로고·워터마크를 넣지 않는다. 흐림·안개 효과로 형태를 뭉개지 않는다.',
  ];
  return lines.join('\n');
}
