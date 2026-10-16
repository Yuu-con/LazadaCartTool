const http = require('http');

async function main() {
  const code = `
    const item = page.locator('.cart-item, [id^="item_"]').filter({ hasText: 'AULA F87 Pro' }).first();
    const itemExists = await item.count() > 0;
    if (!itemExists) return { error: 'Item not found in cart' };

    const details = await item.evaluate(el => {
      return {
        id: el.id,
        className: el.className,
        text: el.innerText,
        isOutOfStock: el.innerText.includes('hết hàng') || el.innerText.includes('không còn'),
        warnings: Array.from(el.querySelectorAll('[class*="error"], [class*="warn"], [class*="tip"], [class*="disable"]')).map(w => w.innerText),
        inputs: Array.from(el.querySelectorAll('input')).map(i => ({ type: i.type, checked: i.checked, disabled: i.disabled })),
        outerHTML: el.outerHTML
      };
    });

    return details;
  `;

  // Start browser if not started
  const reqData = JSON.stringify({ code: `
    if (!page || page.isClosed()) {
      await monitor.ensureBrowser();
      await monitor.safeNavigate('https://cart.lazada.vn/cart');
      await page.waitForTimeout(4000);
    }
    const item = page.locator('.cart-item, [id^="item_"]').filter({ hasText: 'AULA F87 Pro' }).first();
    if (await item.count() === 0) {
      return { error: 'Item not found' };
    }
    return await item.evaluate(el => ({
      id: el.id,
      className: el.className,
      text: el.innerText,
      warnings: Array.from(el.querySelectorAll('[class*="warn"], [class*="error"], [class*="tip"], [class*="invalid"]')).map(w => w.innerText),
      inputs: Array.from(el.querySelectorAll('input')).map(i => ({ type: i.type, checked: i.checked, disabled: i.disabled }))
    }));
  ` });

  // Call exec
  const req = http.request('http://localhost:3000/api/monitor/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqData) }
  }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => console.log('Item details:', d));
  });
  req.write(reqData);
  req.end();
}

main();
