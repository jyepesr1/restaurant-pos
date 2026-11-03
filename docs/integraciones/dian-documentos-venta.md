# DIAN: qué lleva impreso cada documento de venta de un restaurante

**Fecha de consulta:** 2 de noviembre de 2026.
**Para qué sirve:** dibujar el boceto del tiquete y de la factura en impresora térmica de 80 mm (tarea de impresión de Faro). No es asesoría tributaria: todo lo marcado «VALIDAR» debe confirmarlo el contador del restaurante o el proveedor tecnológico.

## 0. Resumen en cinco líneas

1. El documento de la caja del restaurante es el **documento equivalente electrónico tiquete de máquina registradora con sistema P.O.S.** (DEE POS). Su base es la Resolución DIAN 000165 de 2023 (arts. 16, 19, 20 y 35), con las modificaciones de las Resoluciones 000008 y 000119 de 2024. Hoy el texto está compilado en la Resolución 227 de 2025.
2. El **mínimo impreso** del DEE POS lo fija el art. 35, parágrafo 1, de la Res. 165: numerales **1 a 5 y 8 a 12 del art. 19** (denominación, vendedor, impuestos discriminados, consecutivo con rango y vigencia, fecha y hora de generación, valor total, calidad tributaria, software, **CUDE**, **QR**) y, si el cliente quiere soporte de costos o IVA, nombre y número de identificación del adquirente.
3. La **factura electrónica de venta** exige más datos impresos (art. 35, par. 1, con los numerales 1 a 5, 8 a 13, 15, 16 y 18 del art. 11): adquirente siempre, ítems, forma y medio de pago, **CUFE**.
4. El **documento soporte en adquisiciones a no obligados** (Res. 167 de 2021) es otra cosa: lo expide quien **compra** a alguien que no factura. **No es un documento de venta** y no aplica a lo que el restaurante vende a sus clientes.
5. **No encontré en fuente oficial** (o no pude leer): el texto del Anexo Técnico del DEE (el PDF pesa más de 10 MB y mi herramienta no lo abre), cómo se muestra la **propina** dentro del DEE, y el formato exacto de la representación gráfica (la DIAN lo deja al diseño del emisor).

## 1. Estado de la norma

| Norma | Qué hace | Estado a nov-2026 | Fuente |
|---|---|---|---|
| Resolución DIAN 000165 del 1-nov-2023 | Desarrolla el sistema de facturación, crea el DEE (art. 16) y fija su contenido (arts. 19 y 20). Adopta el Anexo Técnico de factura electrónica v1.9 y el **Anexo Técnico 1.0 del DEE** (art. 60). | Vigente, compilada en la Res. 227 de 2025 (arts. 16 a 21 pasan a ser 1.5.1.3.2.1 a 1.5.1.3.2.6, según el normograma). | [Normograma DIAN, Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm) |
| Resolución 000008 del 31-ene-2024 | Reemplaza el calendario del tiquete POS (art. 23, num. 1). | Vigente. | [Res. 000008](https://www.dian.gov.co/normatividad/Normatividad/Resoluci%C3%B3n%20000008%20de%2031-01-2024.pdf) |
| Resolución 000119 del 30-jul-2024 | Cambia la denominación oficial del documento (art. 4) a «Documento equivalente electrónico tiquete de máquina registradora con sistema P.O.S.»; art. 1 reemplaza el inciso 4 del art. 4 de la Res. 165 (los obligados pueden emitir documentos equivalentes y, en todos los casos, optar por factura electrónica). | Vigente. | [Normograma, Res. 119](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0119_2024.htm), [PDF DIAN](https://www.dian.gov.co/normatividad/Normatividad/Resoluci%C3%B3n%20000119%20de%2030-07-2024.Pdf) |
| Resolución 202 de 2025 | Agrega parágrafos a los arts. 20 y 29 (solo servicios públicos domiciliarios). | No afecta a restaurantes. | [Normograma, Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm) |
| Resolución 227 de 2025 (23-sep-2025) | «Resolución Única» que compila las resoluciones DIAN. Título 5 = sistema de facturación. | Vigente. **No pude leer el Título 5** (la página se corta antes). Cito por eso los artículos de la Res. 165 original. | [Normograma, Res. 227](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm) |
| Anexo Técnico del DEE, versión 1.0 | Estructura XML, CUDE (num. 14.1), clave técnica (14.2), QR (14.3), URL del QR (14.4). Caja de herramientas v1.3. | Es la versión que aparece en el micrositio oficial. **No encontré una versión posterior ni una resolución de 2026 que cambie el DEE POS**; confirmar en el micrositio antes de programar. | [Anexo 1.0 (PDF, no pude abrirlo)](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Documento-Equivalente-Electronico-V1-0-final.pdf), [Marco normativo y documentación técnica del DEE](https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/marco-normativo-y-documentacion-tecnica-del-doc-equivalente-electronico/) |

**Calendario del tiquete POS** (art. 23, num. 1, modificado por la Res. 8 de 2024): grandes contribuyentes 1-may-2024; declarantes de renta que no son grandes contribuyentes 1-jun-2024; no declarantes y demás 1-jul-2024. Todos ya vencidos. Fuente: [Normograma, Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm).

**Habilitación previa** (art. 28): el emisor debe habilitarse en el servicio informático de la DIAN, registrar el software, autorizar numeración y clave técnica, y actualizar el RUT con la responsabilidad 52. El servicio gratuito de la DIAN **no** sirve para el DEE (art. 28, par. 2). Esto lo tramita el restaurante con su proveedor tecnológico. Fuente: [Normograma, Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm).

## 2. Documento equivalente electrónico tiquete POS (DEE POS)

### 2.1 Reglas generales que cambian el diseño

- **Sin tope de valor.** El DEE POS «se puede generar independientemente del valor de la operación» (art. 16, parágrafo, inciso 2). El tope de **5 UVT por documento** existe solo para el tiquete POS **antiguo** del parágrafo 2 del art. 616-1 del Estatuto Tributario, que no da derecho a IVA descontable ni a costos y deducciones (Concepto DIAN 020900 int. 1031 de 2024, 18-nov-2024). Referencia: UVT 2026 = $52.374, o sea 5 UVT = $261.870 (Res. DIAN 000238 de 2025, según [INCP](https://incp.org.co/publicaciones/infoincp-publicaciones/impuestos/2025/12/dian-fijo-en-52-374-en-valor-de-la-uvt-para-2026/)). **Ese tope no obliga a cambiar de documento en el DEE POS.** VALIDAR con contador. Fuentes: [Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm), [Concepto 1563 de 2024](https://www.dian.gov.co/Contribuyentes-Plus/Documents/06-CONCEPTO-001563-int-146-04032024.pdf), [Concepto 20900 de 2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_20900_2024.htm).
- **Aviso sobre el Concepto 20900 de 2024:** un párrafo dice que «en la reglamentación del sistema de facturación no se contemplaron requisitos, y ante la ausencia de estos no es posible su aplicación». Por su ubicación parece referirse al tiquete antiguo del art. 616-1, no al DEE, y el mismo concepto afirma que el DEE sí da derecho a costos e IVA descontable. El texto es ambiguo. **VALIDAR con contador.** [Concepto 20900 de 2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_20900_2024.htm).
- **El DEE POS lo usa quien opta por documentos equivalentes.** Si el cliente pide factura a su nombre, hay que poder expedir factura electrónica (Concepto Unificado 106 de 2022, descriptor 1.1.10.1; art. 1 de la Res. 119 de 2024). Faro debe permitir los dos documentos para la misma cuenta. [Concepto 106 de 2022](https://normograma.dian.gov.co/dian/compilacion/docs/concepto_tributario_dian_0000106_2022.htm).
- **El XML es lo que tiene valor legal.** La representación gráfica es «una imagen» del XML y se diseña según las necesidades del emisor, siempre que lleve el QR (Anexo Técnico de factura v1.8, num. 11.3, y Res. 165 art. 66, parágrafo, según la Res. 119 art. 5). El anexo del DEE es la fuente que aplica al tiquete; no pude abrirlo, así que uso el de factura v1.8 solo como indicio. [Anexo v1.8, pág. 582](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Resolucion-000012-09022021.pdf), [Res. 119](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0119_2024.htm).
- **Idioma y moneda:** español y peso colombiano (art. 66 de la Res. 165). [Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm).

### 2.2 Campos impresos mínimos (art. 35, par. 1: numerales 1 a 5 y 8 a 12 del art. 19)

El art. 35, par. 1, dice que las representaciones gráficas (impresas o digitales) del documento equivalente deben incluir los numerales 1 a 5 y 8 a 12 del art. 19. Fuente: [Normograma DIAN, Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm) (confirmado en una segunda copia del normograma de Cancillería).

| N.º art. 19 | Dato | Obligatorio en el impreso | Notas |
|---|---|---|---|
| 1 | Denominación: «Documento equivalente electrónico tiquete de máquina registradora con sistema P.O.S.» | Sí | Texto de la denominación fijado por Res. 119 de 2024, art. 4, y art. 19 num. 1. |
| 2 | Nombre o razón social y NIT del vendedor | Sí | Dirección, teléfono y ciudad: **no los exige el art. 19**; no encontré norma que los pida en el POS. VALIDAR si el contador quiere agregarlos (art. 19, par. 2, permite requisitos adicionales del sector). |
| 3 | Discriminación de IVA, impuesto nacional al consumo, impuesto a bolsas plásticas y otros impuestos aplicables | Sí | Para restaurante: INC. El art. 512-9 del E.T. dice que el impuesto «debe discriminarse en la cuenta de cobro, tiquete de registradora, factura o documento equivalente» (citado en el [Oficio 901713 de 2022](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_901713_2022.htm)). Tarifa general 8 % según el mismo oficio. **Tarifa configurable; VALIDAR con contador** (régimen SIMPLE, excepciones). |
| 4 | Número consecutivo + «número, rango y vigencia autorizada» por la DIAN | Sí | El prefijo de hasta 4 caracteres alfanuméricos está definido para factura (art. 11 num. 4) y el art. 43 lo hace obligatorio con varios establecimientos o puntos de venta. El texto de resolución/fecha de autorización que se imprime lo define el proveedor: No documentado en lo que pude leer. |
| 5 | Fecha y hora de generación | Sí | La «fecha y hora de expedición» (num. 6) no está en el mínimo impreso. |
| 8 | Valor total de la operación | Sí | Ver propina en 2.4. |
| 9 | Calidad de agente retenedor de IVA, autorretenedor, gran contribuyente o contribuyente SIMPLE | Sí, **cuando aplique** | Configurable por restaurante. |
| 10 | Nombre o razón social y NIT del fabricante del software, y nombre del software | Sí | En Faro el «fabricante del software» es quien lo desarrolle. Qué se registra y cómo cuando hay proveedor tecnológico: depende del proveedor. |
| 11 | CUDE (Código Único de Documento Equivalente Electrónico) | Sí | Lo calcula el software según el num. 14.1 del Anexo del DEE (no pude leerlo). **No verifiqué la longitud ni el algoritmo del CUDE del DEE**; es una cadena larga, por lo que en 80 mm hay que partirla en varias líneas. |
| 12 | Dirección de internet de la DIAN contenida en el **código QR** | Sí | Ver 2.3. |

### 2.3 Código QR

- **Qué debe contener:** el art. 19 num. 12 exige «la dirección de internet de la DIAN» dentro del QR. El Anexo Técnico de factura **v1.8** (num. 11.3) define el QR con dos partes: los datos `NumFac`, `FecFac`, `HorFac`, `NitFac`, `DocAdq`, `ValFac`, `ValIva`, `ValOtroIm`, `ValTolFac` y el CUFE/CUDE, y la URL de consulta de la DIAN: producción `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=CUFE/CUDE`, habilitación `https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=CUFE/CUDE`. Fuente: [Anexo v1.8, págs. 579 a 582](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Resolucion-000012-09022021.pdf).
- **No verificado para el DEE:** el índice del Anexo del DEE v1.0 trae las mismas secciones (14.3 «Código bidimensional QR», 14.4 «URL QRCode»), pero **no pude leer su contenido**. No asumir que los campos y la URL del DEE son idénticos a los de factura v1.8. **Pregunta para el proveedor tecnológico:** el proveedor entrega normalmente el texto del QR ya armado; Faro solo debe dibujarlo.
- **Tamaño mínimo:** 2 cm por lado, según el anexo de factura v1.8 (pág. 581). En 80 mm (aprox. 72 mm imprimibles) se puede dibujar mucho más grande; probar la lectura con celular.
- **Todas las páginas:** el QR debe ir en todas las páginas de la representación impresa (Anexo v1.8, pág. 582; [Concepto 4232 de 2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_4232_2024.htm), que cita el Concepto Unificado 106 de 2022). Si un tiquete largo se parte en dos, repetirlo.
- **Qué muestra al escanearlo:** lleva al servicio de consulta de la DIAN para comprobar que los datos coinciden con el documento ([DIAN, nota de prensa del 26-oct-2026](https://www.dian.gov.co/Prensa/Paginas/NG-Aprenda-a-verificar-si-su-factura-electronica-fue-validada-por-la-DIAN-.aspx)). El portal de búsqueda de la DIAN pide CUFE/UUID y NIT del emisor o receptor ([catalogo-vpfe.dian.gov.co](https://catalogo-vpfe.dian.gov.co/User/SearchDocument)). Un resultado de búsqueda (blog de un tercero, no oficial) menciona que desde julio de 2026 la consulta exige además el NIT; la página oficial lo confirma hoy, pero no encontré el anuncio de la DIAN.

### 2.4 Adquirente, propina, medio de pago e ítems

**Adquirente (cliente)**

- Art. 16, parágrafo, inciso 2: para el tiquete POS «se deberá identificar con nombre o razón social y número de identificación al adquirente». Art. 19, par. 1 y art. 27, par.: es indispensable para que sirva de soporte de costos o IVA descontable (con los literales b, d, e y g del art. 617 del E.T.).
- **Consumidor final:** art. 19, par. 1 permite registrar «consumidor final» o el número **222222222222** cuando el cliente no suministra sus datos, **pero entonces el tiquete no sirve como soporte de costos, gastos ni impuestos descontables**. El art. 35, par. 1 pide imprimir nombre e identificación del adquirente «cuando se requiera para soportar» esos conceptos. [Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm).
- **Tensión entre artículos:** el art. 16 dice «se deberá identificar» y el art. 19, par. 1 permite «consumidor final». Lectura razonable: se identifica siempre que el cliente quiera soporte; si no, consumidor final. **VALIDAR con contador.**
- **Qué datos del adquirente exige el anexo (tipo de documento, correo, etc.):** No documentado en lo que pude leer. Un extracto de búsqueda del anexo dice que para consumidor final se usa tipo de documento «13» con 222222222222; **no verificado**.
- Para factura (no para DEE): [Concepto 106 de 2022, 1.1.6](https://normograma.dian.gov.co/dian/compilacion/docs/concepto_tributario_dian_0000106_2022.htm) dice que cada operación se factura en el momento (no hay una sola factura diaria a consumidores finales).

**Propina**

- **La base del INC no incluye la propina:** «En ningún caso la propina, por ser voluntaria, hará parte de la base del Impuesto Nacional al Consumo» (E.T. art. 512-9, citado en [Oficio 901713 de 2022](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_901713_2022.htm)). El INC se calcula sobre el consumo, y la propina se suma aparte.
- **Reglas de cobro (Ley 1935 de 2018):** la propina es voluntaria (art. 2); si el establecimiento la sugiere e incluye en la factura con aceptación del cliente, no puede superar el **10 % del valor del servicio** (art. 3); la factura o documento equivalente es el único documento que se entrega al consumidor para verificar los consumos, y quien atiende debe preguntar si desea incluir la propina o indicar otro valor (art. 4). [Ley 1935 de 2018](https://normativa.colpensiones.gov.co/colpensiones/docs/ley_1935_2018.htm).
- **Superintendencia de Industria y Comercio:** debe preguntarse antes de emitir la factura; avisos obligatorios en la entrada, la carta y la lista de precios (propina voluntaria, destino, derecho a no pagarla o cambiar el monto, contacto de la SIC); el cliente puede cambiarla incluso después de emitida; multas de hasta 2.000 SMMLV. Rige desde el 5-nov-2022. [SIC, instrucciones sobre propinas](https://sedeelectronica.sic.gov.co/noticias/superindustria-actualiza-las-instrucciones-sobre-propinas-en-colombia).
- **No encontré en fuente oficial** cómo se codifica la propina dentro del XML del DEE ni si va dentro del «valor total» del art. 19 num. 8, ni si el anexo la trata como «ingreso para terceros», cargo u otro concepto. Los blogs de proveedores dicen que va discriminada y separada del consumo; **no son fuente**. Para el boceto: imprimir la propina como línea separada, después del INC y antes del total a pagar, y marcarlo como pendiente. **Pregunta para proveedor y contador.**

**Medio de pago e ítems**

- **Medio de pago:** el art. 19 no lo incluye. En la factura sí (art. 11 num. 10 y 11). Para el DEE POS: No documentado en la parte que leí; imprimirlo es útil para el cierre de caja, pero no es exigencia del art. 19. El anexo podría tener un campo; preguntar.
- **Ítems:** el art. 20 num. 1 exige que el tiquete POS indique «cantidad, unidad de medida, y descripción específica y códigos que permitan la identificación» de los bienes o servicios, y que el sistema identifique cada bien o servicio con su departamento y tarifa de IVA e INC, y que cada artículo tenga código de barras u otra identificación interna. Los ítems **no están** en la lista mínima del art. 35, par. 1 (que solo remite al art. 19), pero sí son contenido del documento (XML). Es lo habitual imprimirlos. VALIDAR. [Res. 165, art. 20](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm), [DIAN, micrositio DEE](https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/documento-equivalente-electronico/).

### 2.5 Campos del DEE que van en el XML pero no en el mínimo impreso

Fecha y hora de expedición (art. 19 num. 6), entrega con el documento de validación «Documento validado por la Dian» en el contenedor electrónico (num. 7), firma digital del emisor (num. 13), y las condiciones técnicas del anexo (num. 15). [Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm). La fecha y hora de expedición es la de validación por la DIAN; puede mostrarse, pero el mínimo impreso no la pide.

### 2.6 Sin internet, sin DIAN o sin proveedor (art. 37 y 21)

- Inconveniente del emisor: se genera el documento equivalente **en físico** con los requisitos de los arts. 19 y 20, **salvo los numerales 10, 11, 12, 13 y 15 del art. 19** (software, CUDE, QR, firma, condiciones del anexo) (art. 21), y se transmite el XML dentro de las **48 horas** siguientes a superar el inconveniente (art. 37 num. 2.2). Si falla la DIAN, se transmite en 48 horas desde que se restablezca el servicio (num. 2.1). Las mismas reglas aplican si falla el proveedor tecnológico (art. 37, par. 2). [Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm).
- **Consecuencia para Faro:** hace falta un **formato de tiquete de contingencia** sin CUDE ni QR, y una cola que transmita en 48 horas. El «documento equivalente físico» exige la numeración autorizada (art. 21, art. 42). VALIDAR con contador y proveedor cómo se numera y marca ese formato.
- **Notas de ajuste** (art. 22): son el mecanismo de anulación o corrección del DEE; llevan consecutivo propio, CUDE propio y el CUDE y fecha del documento corregido. El número anulado no se reutiliza. Esto encaja con «nada se borra» y con reabrir una cuenta cerrada (BRIEF).

## 3. Factura electrónica de venta (cliente la pide a su nombre o NIT)

### 3.1 Campos impresos mínimos (art. 35, par. 1: numerales 1 a 5, 8 a 13, 15, 16 y 18 del art. 11)

Fuente de la lista de numerales: [Res. 165, art. 35](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm). Contenido de cada numeral: art. 11 de la misma resolución. También lo confirma la [DIAN en un Concepto de 2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_4232_2024.htm) (si el emisor entrega una representación sin los datos mínimos, se considera que no entregó la factura).

| N.º art. 11 | Dato | Obligatorio impreso | Notas |
|---|---|---|---|
| 1 | Denominación expresa: «factura electrónica de venta» | Sí | E.T. art. 617 lit. a. |
| 2 | Nombre o razón social y NIT del vendedor | Sí | |
| 3 | Adquirente: **3.1** nombre o razón social y NIT; **3.2** si no da NIT, nombres, apellidos y número de identificación; **3.3** si no da nada, «consumidor final» o 222222222222 | Sí | Dirección de entrega solo si la venta se hace **fuera del establecimiento** (domicilio). Con «consumidor final» la factura no soporta costos ni IVA descontable: verificar con el contador (la Res. 165 lo dice expresamente para el tiquete POS, art. 19 par. 1; para factura el [Concepto 106 de 2022](https://normograma.dian.gov.co/dian/compilacion/docs/concepto_tributario_dian_0000106_2022.htm) acepta usar 222222222222). |
| 4 | Número consecutivo con prefijo de hasta 4 caracteres alfanuméricos, fecha y vigencia de la autorización | Sí | Número de la resolución de autorización: lo entrega la DIAN y el proveedor. |
| 5 | Fecha y hora de generación | Sí | |
| 8 | Líneas o ítems: cantidad, unidad de medida, descripción y códigos de identificación | Sí | |
| 9 | Valor total de la venta | Sí | |
| 10 | Forma de pago: contado o crédito (con plazo) | Sí | |
| 11 | Medio de pago (efectivo, tarjeta, transferencia u otro), si es de contado | Sí | |
| 12 | Calidad de agente retenedor de IVA, autorretenedor, gran contribuyente o SIMPLE | Sí, cuando aplique | |
| 13 | Discriminación de IVA, INC, bolsas plásticas, impuestos saludables y otros, con su tarifa | Sí | Tarifa visible (a diferencia del DEE, donde el art. 19 num. 3 no dice «con su tarifa»). |
| 15 | CUFE | Sí | |
| 16 | Dirección de internet de la DIAN dentro del QR | Sí | |
| 18 | NIT y razón social del fabricante del software, nombre del software y nombre del proveedor tecnológico si lo hay | Sí | Más completo que el DEE: incluye el proveedor tecnológico. |

No exigidos en el impreso: num. 6 (fecha y hora de expedición), 7 (entrega con documento de validación), 14 (firma digital) y 17 (anexo técnico). [Res. 165, art. 11 y art. 35](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm).

### 3.2 Diferencias con el tiquete POS (representación gráfica)

| Punto | DEE POS (art. 19) | Factura (art. 11) |
|---|---|---|
| Identificador | CUDE | CUFE |
| Adquirente impreso | Solo si quiere soporte de costos o IVA; si no, «consumidor final» | Siempre (con NIT o ID, o «consumidor final») |
| Ítems impresos | No listados en el mínimo (sí en art. 20 num. 1, para el documento) | Sí (num. 8) |
| Forma y medio de pago | No listados | Sí (num. 10 y 11) |
| Tarifa de cada impuesto | «Discriminación» (num. 3) | «Con su tarifa» (num. 13) |
| Numeración | Número, rango y vigencia autorizados | Prefijo ≤ 4 caracteres, fecha y vigencia |
| Proveedor tecnológico | Solo fabricante y nombre del software | Fabricante, software y proveedor tecnológico |
| Derecho del cliente a costos e IVA descontable | Solo si se identifica al adquirente | Sí, cumpliendo los requisitos del art. 617 del E.T. |
| Contingencia en papel | Permitida con arts. 19 y 20 sin num. 10 a 13 y 15 | Factura de talonario o papel solo por inconvenientes tecnológicos (art. 10 y 37) |

El QR y la regla «el XML es lo legal» son iguales en ambos. [Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm).

### 3.3 Entrega al cliente

El adquirente que no es facturador puede recibir la factura impresa (representación gráfica) si no indica otro medio (art. 35, num. 2.5). La representación debe ser fácil de leer, copiar, descargar e imprimir (art. 35, par. 1). [Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm). Si se entrega solo la impresión y el cliente es empresa, VALIDAR con el proveedor si debe enviarse además el XML por correo.

## 4. Documento soporte en adquisiciones a no obligados a facturar

- **Qué es:** documento que expide **quien compra** bienes o servicios a una persona **no obligada a facturar**, para soportar sus costos, deducciones e IVA descontable (Res. 167 de 2021, arts. 1, 2 y 3). Lo generan los adquirentes que son facturadores electrónicos, contribuyentes de renta y responsables de IVA. Lleva su propio código (CUDS) y su numeración. [Normograma, Res. 167 de 2021](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0167_2021.htm); numeración, arts. 42 a 46 de la [Res. 165](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm).
- **¿Aplica a las ventas de un restaurante?** **No.** El restaurante que vende a sus clientes expide tiquete POS (DEE) o factura. El documento soporte solo aparecería si el restaurante **compra** a un proveedor que no factura (por ejemplo, a un productor informal). El texto de la Res. 167 no menciona restaurantes. [Res. 167 de 2021](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0167_2021.htm).
- **Para el dueño:** si dijo «documento soporte» pensando en el documento de venta, lo más probable es que se refiera al DEE POS o a la factura. **Preguntarle qué documento le entrega hoy su proveedor actual.**
- No hace falta imprimirlo en 80 mm en la fase de ventas. Faro no debe mezclarlo con el cierre de cuentas. Si en el futuro se registra compras, es otro módulo.
- La Res. 167 de 2021 fue modificada por la Res. 488 de 2022 (fecha de implementación, art. 6) y hoy está compilada en la Res. 227 de 2025: confirmar el artículo vigente si se llega a implementar.

## 5. Orden sugerido de los campos en un tiquete de 80 mm (diseño, no norma)

La DIAN deja el diseño al emisor mientras lleve los datos mínimos y el QR ([Anexo v1.8, pág. 582](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Resolucion-000012-09022021.pdf); [Res. 165, art. 66](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm)). Este orden es una propuesta basada en los numerales; no viene de la DIAN.

**DEE POS**

1. Nombre del restaurante y razón social del vendedor + NIT (art. 19 num. 2).
2. Calidad tributaria si aplica: agente retenedor, gran contribuyente, SIMPLE (num. 9).
3. Denominación «Documento equivalente electrónico tiquete de máquina registradora con sistema P.O.S.» (num. 1).
4. Consecutivo (prefijo + número) y «autorización/rango/vigencia» (num. 4).
5. Fecha y hora de generación (num. 5).
6. Adquirente: nombre e identificación, o «consumidor final 222222222222» (art. 16 y 19 par. 1).
7. Mesa, mesero y comensales (no exigidos por la DIAN; datos propios).
8. Ítems: cantidad, descripción (y código/unidad en el XML) y valor (art. 20 num. 1).
9. Subtotal, INC por tarifa y valor (num. 3), propina separada (pendiente de validar), total (num. 8).
10. Medio de pago (no exigido por art. 19, útil para caja).
11. CUDE en líneas cortas (num. 11).
12. Código QR (num. 12).
13. Fabricante y nombre del software (num. 10).
14. Leyenda de propina voluntaria (Ley 1935 y SIC) y mensaje del restaurante.

**Factura electrónica de venta**

1. Vendedor: razón social, NIT (num. 2) y calidad tributaria (num. 12).
2. «Factura electrónica de venta» (num. 1).
3. Prefijo y número, y autorización con vigencia (num. 4).
4. Fecha y hora de generación (num. 5).
5. Adquirente: razón social y NIT, o nombres e ID, o consumidor final (num. 3), y dirección de entrega si es a domicilio.
6. Forma de pago y medio de pago (num. 10 y 11).
7. Ítems con cantidad, unidad, descripción y código (num. 8).
8. Impuestos con su tarifa (num. 13), propina separada (pendiente), valor total (num. 9).
9. CUFE (num. 15).
10. QR (num. 16).
11. Fabricante, software y proveedor tecnológico (num. 18).

## 6. Lo que no encontré o no pude leer

- Contenido del **Anexo Técnico del DEE v1.0** (PDF de la DIAN de más de 10 MB; mi herramienta no lo abre): sección 14.1 (cálculo del CUDE), 14.3 y 14.4 (QR y URL), campos obligatorios del XML, tipo de documento del consumidor final, tratamiento de la propina.
- Título 5 de la **Res. 227 de 2025** (página truncada): números de artículo en la compilación, más allá de la correspondencia 16 a 21 → 1.5.1.3.2.1 a 1.5.1.3.2.6.
- Texto literal de los literales b, d, e y g del **art. 617 del E.T.** en su redacción vigente (los vi solo a través de resultados de búsqueda del normograma DIAN, que además advierte que la redacción varía entre compilaciones).
- Si la propina va dentro o fuera del valor total en el XML del DEE.
- Si el medio de pago, la mesa o el mesero pueden o deben ir impresos (la norma leída no lo exige).
- Cualquier resolución o concepto de 2026 que cambie el DEE POS (no encontré ninguno; la búsqueda no es exhaustiva).

## 7. Preguntas abiertas

**Para el proveedor tecnológico (por elegir)**

1. ¿Qué versión del Anexo Técnico del DEE usa (1.0 u otra) y qué campos exige en tiquete POS?
2. ¿Entrega el texto del QR y el CUDE ya calculados, o los calcula Faro? ¿Cuál es la URL exacta del QR del DEE en producción y en habilitación?
3. ¿Cómo se informa la propina en el XML (concepto aparte, cargo, ingreso para terceros) y entra o no en el valor total?
4. ¿Qué datos del adquirente exige el XML (tipo de documento, correo, dirección) y cómo se envía un «consumidor final»?
5. ¿Qué se imprime como «autorización, rango y vigencia» y qué debe decir el campo de software y proveedor tecnológico?
6. ¿Cómo funciona la contingencia (sin internet o con la DIAN caída): numeración física, marcado del tiquete y reenvío dentro de 48 horas?
7. ¿Soporta emitir factura electrónica y DEE POS desde la misma cuenta, y notas de ajuste para anular o corregir?

**Para el contador del restaurante**

1. ¿Usará DEE POS, factura electrónica o ambos? ¿Qué pasa con clientes que piden factura a su nombre?
2. ¿Qué tarifa de INC y qué calidad tributaria (agente retenedor, SIMPLE, etc.) tiene cada restaurante?
3. ¿Se acepta «consumidor final» sin más cuando el cliente no pide factura?
4. ¿Cómo se registra la propina contablemente (ingreso para terceros) y se muestra en el documento?
5. ¿Es correcta la lectura de que el tope de 5 UVT no aplica al DEE POS (Concepto 20900 de 2024)?
6. ¿Faltan datos del establecimiento (dirección, teléfono) que el contador quiera impresos?

**Para el dueño (La Spritzzería)**

1. ¿Qué documento le entrega hoy su sistema actual y cómo lo llama? (El nombre «documento soporte» no corresponde a ventas.)
2. ¿Quién es su proveedor tecnológico actual de facturación?

## 8. Enlaces (fuentes consultadas)

Oficiales (DIAN y entidades públicas)

- [Resolución DIAN 165 de 2023, normograma DIAN](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm). Segunda copia: [Cancillería](https://cancilleria.gov.co/sites/default/files/Normograma/docs/resolucion_dian_0165_2023.htm).
- [Resolución DIAN 119 de 2024, normograma DIAN](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0119_2024.htm).
- [Resolución DIAN 000008 de 2024, PDF](https://www.dian.gov.co/normatividad/Normatividad/Resoluci%C3%B3n%20000008%20de%2031-01-2024.pdf).
- [Resolución DIAN 227 de 2025 (Resolución Única), normograma DIAN](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm).
- [Resolución DIAN 167 de 2021 (documento soporte), normograma DIAN](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0167_2021.htm).
- [Micrositio DIAN: Documento Equivalente Electrónico](https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/documento-equivalente-electronico/).
- [Micrositio DIAN: marco normativo y documentación técnica del DEE](https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/marco-normativo-y-documentacion-tecnica-del-doc-equivalente-electronico/).
- [Anexo Técnico del DEE v1.0 (PDF, no abierto)](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Documento-Equivalente-Electronico-V1-0-final.pdf).
- [Anexo Técnico de factura electrónica v1.8, Res. 000012 de 2021 (QR, págs. 579 a 582)](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Resolucion-000012-09022021.pdf). Superado por la v1.9 ([PDF, no abierto](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Factura-Electronica-de-Venta-vr-1-9.pdf)); solo como indicio para el DEE.
- [Concepto DIAN 001563 int. 146 de 2024](https://www.dian.gov.co/Contribuyentes-Plus/Documents/06-CONCEPTO-001563-int-146-04032024.pdf): el DEE POS se genera sin importar el valor; para soporte de costos se debe indicar el nombre o razón social del adquirente.
- [Concepto DIAN 020900 int. 1031 de 2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_20900_2024.htm): diferencia entre el tiquete POS del art. 616-1 (tope 5 UVT) y el DEE.
- [Concepto DIAN 004232 de 2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_4232_2024.htm): datos mínimos de la representación gráfica y QR en todas las páginas.
- [Concepto Unificado DIAN 106 de 2022](https://normograma.dian.gov.co/dian/compilacion/docs/concepto_tributario_dian_0000106_2022.htm).
- [Oficio DIAN 901713 de 2022](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_901713_2022.htm): art. 512-9 del E.T. (propina fuera de la base del INC; INC discriminado en tiquete; tarifa 8 %).
- [DIAN, nota de prensa «Aprenda a verificar si su factura electrónica fue validada»](https://www.dian.gov.co/Prensa/Paginas/NG-Aprenda-a-verificar-si-su-factura-electronica-fue-validada-por-la-DIAN-.aspx).
- [DIAN, portal de consulta de documentos](https://catalogo-vpfe.dian.gov.co/User/SearchDocument).
- [Ley 1935 de 2018 (propinas), Colpensiones/normograma](https://normativa.colpensiones.gov.co/colpensiones/docs/ley_1935_2018.htm).
- [SIC, instrucciones sobre propinas](https://sedeelectronica.sic.gov.co/noticias/superindustria-actualiza-las-instrucciones-sobre-propinas-en-colombia).

No oficial (solo como dato de apoyo, no como fuente final)

- [INCP, UVT 2026 = $52.374](https://incp.org.co/publicaciones/infoincp-publicaciones/impuestos/2025/12/dian-fijo-en-52-374-en-valor-de-la-uvt-para-2026/), que refiere la Res. DIAN 000238 de 2025.
